import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import {
  type CalendarOutboxRow,
  type CalendarRow,
  calendars,
  type SeriesRow,
  series,
} from "../db/schema.js";
import {
  type GoogleCalendarClient,
  GoogleCalendarWriteError,
  type GoogleEvent,
  type SendUpdatesPolicy,
} from "./google/client.js";
import { buildGoogleEventBody } from "./google/event-body.js";
import {
  revertMoveFailure,
  revertSeriesFromUpstreamSnapshot,
  writeRollback,
} from "./outbox-rollback.js";
import {
  claimOutboxEntry,
  deleteOutboxEntry,
  releaseOutboxForReauth,
  scheduleOutboxRetry,
} from "./outbox-store.js";

/**
 * One outbox row's whole push (#237, ADR-0025) — `outbox-loop.ts`'s only
 * per-row call, already holding an access token (a row nothing can mint one
 * for right now is never claimed at all — see `outbox-loop.ts`'s own doc
 * comment for why that alone gives Needs Reauth its "holds indefinitely,
 * counts no attempt, moves no deadline" behaviour with no state of its own).
 */
export async function processOutboxEntry(
  db: Db,
  id: string,
  deps: {
    client: GoogleCalendarClient;
    accessToken: string;
    logger?: FastifyBaseLogger;
    now?: Date;
  },
): Promise<void> {
  const now = deps.now ?? new Date();
  const row = await claimOutboxEntry(db, id, now);
  if (!row) return; // Lost the claim — another tick already took it, or it's no longer due.

  const [seriesRow] = await db.select().from(series).where(eq(series.id, row.seriesId));
  if (!seriesRow) {
    // A permanent delete (`deleteSeriesPermanently`) raced this push — nothing left to push or revert.
    await deleteOutboxEntry(db, row.id);
    return;
  }

  // Conflict shape 3 (ADR-0025): a delta already moved this Series' `etag`
  // since the row was (re)enqueued — no network call needed to know this is
  // a conflict.
  if (row.baseEtag !== null && seriesRow.etag !== row.baseEtag) {
    await reject(
      db,
      row,
      seriesRow,
      "Google's copy of this event changed while the edit was still queued.",
    );
    return;
  }

  const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
  if (!calendarRow || calendarRow.connectedAccountId === null) {
    // Unmirrored, or the Calendar itself is gone, underneath the queued write — nothing to push.
    await deleteOutboxEntry(db, row.id);
    return;
  }
  const googleCalendarId = calendarRow.id.slice(`gcal:${calendarRow.connectedAccountId}:`.length);
  const sendUpdates: SendUpdatesPolicy = row.sendInvitations ? "all" : "none";

  // `operation: "move"` (#238) carries both halves of the push — the source
  // Series/Calendar to cancel out of, alongside `seriesRow`/`calendarRow`
  // above naming the destination to insert into.
  let moveFrom: { seriesRow: SeriesRow; calendarRow: CalendarRow } | null = null;
  if (row.operation === "move" && row.moveFromSeriesId) {
    const [fromSeries] = await db.select().from(series).where(eq(series.id, row.moveFromSeriesId));
    if (fromSeries) {
      const [fromCalendar] = await db
        .select()
        .from(calendars)
        .where(eq(calendars.id, fromSeries.calendarId));
      if (fromCalendar) moveFrom = { seriesRow: fromSeries, calendarRow: fromCalendar };
    }
  }

  try {
    const pushed = await pushToGoogle(
      deps.client,
      deps.accessToken,
      googleCalendarId,
      row.operation,
      seriesRow,
      sendUpdates,
      seriesRow.etag,
      moveFrom,
    );
    if (pushed) {
      await db
        .update(series)
        .set({
          upstreamId: pushed.id,
          etag: pushed.etag ?? null,
          upstreamSnapshot: snapshotOf(seriesRow, pushed),
        })
        .where(eq(series.id, seriesRow.id));
    }
    await deleteOutboxEntry(db, row.id);
  } catch (err) {
    if (!(err instanceof GoogleCalendarWriteError)) throw err;

    if (err.kind === "needsReauth") {
      await releaseOutboxForReauth(db, row, now);
      return;
    }
    if (err.kind === "conflict") {
      await reject(db, row, seriesRow, "Google rejected this change: its copy has moved on.");
      return;
    }
    if (err.kind === "permanent") {
      await reject(db, row, seriesRow, err.message);
      return;
    }
    // transient
    const { expired } = await scheduleOutboxRetry(db, row, err.message, now);
    if (expired) await reject(db, row, seriesRow, err.message);
  }
}

async function pushToGoogle(
  client: GoogleCalendarClient,
  accessToken: string,
  googleCalendarId: string,
  operation: CalendarOutboxRow["operation"],
  seriesRow: SeriesRow,
  sendUpdates: SendUpdatesPolicy,
  ifMatchEtag: string | null,
  moveFrom: { seriesRow: SeriesRow; calendarRow: CalendarRow } | null = null,
): Promise<GoogleEvent | null> {
  const body = buildGoogleEventBody(seriesRow);

  if (operation === "move") {
    // Cancel-first (#238): if the source's cancel lands but the destination's
    // insert then fails, best-effort uncancel it rather than leave a
    // silently-dropped Event upstream — ADR-0025's "a wrong merge is worse
    // than a visible loss the User can redo" only ever applies to what this
    // ticket's own local revert does next (`outbox-rollback.ts#revertMoveFailure`),
    // never to leaving Google itself in a state nothing here reverted.
    let cancelledSource = false;
    try {
      if (moveFrom?.seriesRow.upstreamId && moveFrom.calendarRow.connectedAccountId !== null) {
        const fromGoogleCalendarId = moveFrom.calendarRow.id.slice(
          `gcal:${moveFrom.calendarRow.connectedAccountId}:`.length,
        );
        await client.patchEvent(accessToken, fromGoogleCalendarId, moveFrom.seriesRow.upstreamId, {
          body: { status: "cancelled" },
          sendUpdates,
          ifMatchEtag: moveFrom.seriesRow.etag,
        });
        cancelledSource = true;
      }
      return await client.insertEvent(accessToken, googleCalendarId, { body, sendUpdates });
    } catch (err) {
      if (cancelledSource && moveFrom) {
        const fromGoogleCalendarId = moveFrom.calendarRow.id.slice(
          `gcal:${moveFrom.calendarRow.connectedAccountId}:`.length,
        );
        await client
          .patchEvent(accessToken, fromGoogleCalendarId, moveFrom.seriesRow.upstreamId as string, {
            body: { status: "confirmed" },
            sendUpdates,
          })
          .catch(() => {
            // Best-effort only — the local revert below still restores the
            // Series either way; a Rollback toast is honest even if Google's
            // own copy stays wrong until the User retries.
          });
      }
      throw err;
    }
  }

  if (operation === "cancel") {
    if (!seriesRow.upstreamId) {
      // Never pushed upstream at all (a create raced by a trash) — nothing to cancel.
      return null;
    }
    return client.patchEvent(accessToken, googleCalendarId, seriesRow.upstreamId, {
      body: { status: "cancelled" },
      sendUpdates,
      ifMatchEtag,
    });
  }

  if (operation === "restore") {
    // ADR-0025's own acceptance line: a status flip, never a fresh create —
    // except a Series that somehow never had an upstream event at all
    // (its very first push raced a trash before landing), where there is
    // nothing left to flip and a create is the only honest option.
    if (seriesRow.upstreamId) {
      return client.patchEvent(accessToken, googleCalendarId, seriesRow.upstreamId, {
        body: { ...body, status: "confirmed" },
        sendUpdates,
        ifMatchEtag,
      });
    }
    return client.insertEvent(accessToken, googleCalendarId, { body, sendUpdates });
  }

  // "upsert" and "respond" (#240): identical push for Google — a Series' own
  // `attendees` (with the just-answered `responseStatus`, `series-store.ts
  // #answerInvitation`) rides the ordinary full-body `PATCH` like any other
  // field; `row.responseStatus` above is a Graph-only concern.
  if (seriesRow.upstreamId) {
    return client.patchEvent(accessToken, googleCalendarId, seriesRow.upstreamId, {
      body,
      sendUpdates,
      ifMatchEtag,
    });
  }
  return client.insertEvent(accessToken, googleCalendarId, { body, sendUpdates });
}

/**
 * What a successful push leaves behind on `series` (`upstreamSnapshot`'s own
 * doc comment on `db/schema.ts`): the local fields just pushed, since a
 * successful push is by definition what upstream now holds — reparsing
 * Google's own response body back into this Series' storage form would be
 * real additional surface for no benefit, when the outgoing body already
 * *is* the answer.
 */
function snapshotOf(seriesRow: SeriesRow, pushed: GoogleEvent): Record<string, unknown> {
  return {
    title: seriesRow.title,
    description: seriesRow.description,
    location: seriesRow.location,
    allDay: seriesRow.allDay,
    floating: seriesRow.floating,
    tzid: seriesRow.tzid,
    dtstart: seriesRow.dtstart.toISOString(),
    durationMs: seriesRow.durationMs,
    rrules: seriesRow.rrules,
    rdates: seriesRow.rdates,
    exdates: seriesRow.exdates,
    transparency: seriesRow.transparency,
    attendees: seriesRow.attendees,
    reminders: seriesRow.reminders,
    upstreamId: pushed.id,
    etag: pushed.etag ?? null,
  };
}

async function reject(
  db: Db,
  row: CalendarOutboxRow,
  seriesRow: SeriesRow,
  reason: string,
): Promise<void> {
  // A rejected `move` (#238) reverts as one unit: the destination Series
  // (never confirmed upstream) is dropped the same way any other
  // never-synced Series is, and the source Series — soft-deleted the moment
  // the move was requested — comes back, so the User ends up exactly where
  // they started rather than with the Event gone from both Calendars.
  let entityId: string;
  if (row.operation === "move") {
    entityId = await revertMoveFailure(db, seriesRow, row.moveFromSeriesId);
  } else {
    await revertSeriesFromUpstreamSnapshot(db, seriesRow);
    entityId = row.seriesId;
  }
  await writeRollback(db, { userId: row.userId, entityId, reason });
  await deleteOutboxEntry(db, row.id);
}
