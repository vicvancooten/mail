import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/client.js";
import { type CalendarOutboxRow, calendars, type SeriesRow, series } from "../../db/schema.js";
import {
  revertMoveFailure,
  revertSeriesFromUpstreamSnapshot,
  writeRollback,
} from "../outbox-rollback.js";
import {
  claimOutboxEntry,
  deleteOutboxEntry,
  releaseOutboxForReauth,
  scheduleOutboxRetry,
} from "../outbox-store.js";
import { type CaldavAuth, type CaldavCalendarClient, CaldavWriteError } from "./client.js";
import { buildCaldavEventBody, withCancelledStatus, withConfirmedStatus } from "./event-body.js";
import { caldavHrefFromRowId } from "./fold.js";

/**
 * One outbox row's whole push to a CalDAV server (#247) — `outbox-processor
 * .ts`'s own shape (claim, conflict-shape-3 check, push, snapshot, delete;
 * reject on anything else) reused verbatim, `graph/outbox-processor.ts`'s
 * own precedent for a second provider sharing that shape wholesale. Only
 * *how a push actually talks to the upstream* differs: a `PUT` of a full
 * `.ics` body under `If-Match` (`series.etag`) and, where the server ever
 * handed one back, `If-Schedule-Tag-Match` (`series.davScheduleTag`) — RFC
 * 6638 §3.3's second conditional-write axis, respected alongside `If-Match`
 * rather than instead of it.
 *
 * `move` (#238) is the same cancel-first shape `outbox-processor.ts#pushToGoogle`
 * already gives: a best-effort un-cancel of the source if the destination
 * insert then fails, so a half-moved Event is never silently left upstream.
 */
export async function processCaldavOutboxEntry(
  db: Db,
  id: string,
  deps: {
    client: CaldavCalendarClient;
    auth: CaldavAuth;
    logger?: FastifyBaseLogger;
    now?: Date;
  },
): Promise<void> {
  const now = deps.now ?? new Date();
  const row = await claimOutboxEntry(db, id, now);
  if (!row) return; // Lost the claim — another tick already took it, or it's no longer due.

  const [seriesRow] = await db.select().from(series).where(eq(series.id, row.seriesId));
  if (!seriesRow) {
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
      "The CalDAV server's copy of this event changed while the edit was still queued.",
    );
    return;
  }

  const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
  if (!calendarRow || calendarRow.connectedAccountId === null) {
    await deleteOutboxEntry(db, row.id);
    return;
  }
  const calendarHref = caldavHrefFromRowId(calendarRow.id, calendarRow.connectedAccountId);

  let moveFrom: { seriesRow: SeriesRow; calendarHref: string } | null = null;
  if (row.operation === "move" && row.moveFromSeriesId) {
    const [fromSeries] = await db.select().from(series).where(eq(series.id, row.moveFromSeriesId));
    if (fromSeries) {
      const [fromCalendar] = await db
        .select()
        .from(calendars)
        .where(eq(calendars.id, fromSeries.calendarId));
      if (fromCalendar && fromCalendar.connectedAccountId !== null) {
        moveFrom = {
          seriesRow: fromSeries,
          calendarHref: caldavHrefFromRowId(fromCalendar.id, fromCalendar.connectedAccountId),
        };
      }
    }
  }

  try {
    const pushed = await pushToCaldav(
      deps.client,
      deps.auth,
      calendarHref,
      row.operation,
      seriesRow,
      moveFrom,
    );
    if (pushed) {
      await db
        .update(series)
        .set({
          upstreamId: pushed.url,
          etag: pushed.etag,
          davScheduleTag: pushed.scheduleTag,
          upstreamSnapshot: snapshotOf(seriesRow, pushed),
        })
        .where(eq(series.id, seriesRow.id));
    } else if (row.operation === "cancel") {
      // Never had anything upstream to cancel (a create raced by a trash) —
      // nothing to snapshot from either.
    }
    await deleteOutboxEntry(db, row.id);
  } catch (err) {
    if (!(err instanceof CaldavWriteError)) throw err;

    if (err.kind === "needsReauth") {
      await releaseOutboxForReauth(db, row, now);
      return;
    }
    if (err.kind === "conflict") {
      await reject(
        db,
        row,
        seriesRow,
        "The CalDAV server rejected this change: its copy has moved on.",
      );
      return;
    }
    if (err.kind === "permanent") {
      await reject(db, row, seriesRow, err.message);
      return;
    }
    const { expired } = await scheduleOutboxRetry(db, row, err.message, now);
    if (expired) await reject(db, row, seriesRow, err.message);
  }
}

interface CaldavPushResult {
  url: string;
  etag: string | null;
  scheduleTag: string | null;
}

async function pushToCaldav(
  client: CaldavCalendarClient,
  auth: CaldavAuth,
  calendarHref: string,
  operation: CalendarOutboxRow["operation"],
  seriesRow: SeriesRow,
  moveFrom: { seriesRow: SeriesRow; calendarHref: string } | null,
): Promise<CaldavPushResult | null> {
  const eventUrl = () =>
    new URL(`${encodeURIComponent(seriesRow.uid)}.ics`, calendarHref).toString();

  if (operation === "move") {
    let cancelledSourceUrl: string | null = null;
    try {
      if (moveFrom?.seriesRow.upstreamId) {
        const currentBody = buildCaldavEventBody(moveFrom.seriesRow.uid, moveFrom.seriesRow);
        await client.putObject(
          auth,
          moveFrom.seriesRow.upstreamId,
          withCancelledStatus(currentBody),
          {
            ifMatchEtag: moveFrom.seriesRow.etag,
            ifScheduleTagMatch: moveFrom.seriesRow.davScheduleTag,
            isCreate: false,
          },
        );
        cancelledSourceUrl = moveFrom.seriesRow.upstreamId;
      }
      const result = await client.putObject(
        auth,
        eventUrl(),
        buildCaldavEventBody(seriesRow.uid, seriesRow),
        {
          isCreate: true,
        },
      );
      return { url: eventUrl(), ...result };
    } catch (err) {
      if (cancelledSourceUrl && moveFrom) {
        await client
          .putObject(
            auth,
            cancelledSourceUrl,
            withConfirmedStatus(buildCaldavEventBody(moveFrom.seriesRow.uid, moveFrom.seriesRow)),
            { isCreate: false },
          )
          .catch(() => {
            // Best-effort only — the local revert below still restores the
            // Series either way.
          });
      }
      throw err;
    }
  }

  if (operation === "cancel") {
    if (!seriesRow.upstreamId) return null;
    const body = withCancelledStatus(buildCaldavEventBody(seriesRow.uid, seriesRow));
    const result = await client.putObject(auth, seriesRow.upstreamId, body, {
      ifMatchEtag: seriesRow.etag,
      ifScheduleTagMatch: seriesRow.davScheduleTag,
      isCreate: false,
    });
    return { url: seriesRow.upstreamId, ...result };
  }

  if (operation === "restore") {
    if (seriesRow.upstreamId) {
      const body = withConfirmedStatus(buildCaldavEventBody(seriesRow.uid, seriesRow));
      const result = await client.putObject(auth, seriesRow.upstreamId, body, {
        ifMatchEtag: seriesRow.etag,
        ifScheduleTagMatch: seriesRow.davScheduleTag,
        isCreate: false,
      });
      return { url: seriesRow.upstreamId, ...result };
    }
    const result = await client.putObject(
      auth,
      eventUrl(),
      buildCaldavEventBody(seriesRow.uid, seriesRow),
      { isCreate: true },
    );
    return { url: eventUrl(), ...result };
  }

  // "upsert" and "respond" (#240): identical push — a Series' own
  // `attendees` (with the just-answered `responseStatus`) rides the
  // ordinary full-body `PUT` like any other field, `google/outbox-
  // processor.ts`'s own reasoning for why Google needs no dedicated
  // "respond" request shape either.
  const body = buildCaldavEventBody(seriesRow.uid, seriesRow);
  if (seriesRow.upstreamId) {
    const result = await client.putObject(auth, seriesRow.upstreamId, body, {
      ifMatchEtag: seriesRow.etag,
      ifScheduleTagMatch: seriesRow.davScheduleTag,
      isCreate: false,
    });
    return { url: seriesRow.upstreamId, ...result };
  }
  const result = await client.putObject(auth, eventUrl(), body, { isCreate: true });
  return { url: eventUrl(), ...result };
}

/** What a successful push leaves behind on `series` — `outbox-processor.ts#snapshotOf`'s own reasoning: the local fields just pushed, since a successful push is by definition what upstream now holds. */
function snapshotOf(seriesRow: SeriesRow, pushed: CaldavPushResult): Record<string, unknown> {
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
    upstreamId: pushed.url,
    etag: pushed.etag,
    davScheduleTag: pushed.scheduleTag,
  };
}

async function reject(
  db: Db,
  row: CalendarOutboxRow,
  seriesRow: SeriesRow,
  reason: string,
): Promise<void> {
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
