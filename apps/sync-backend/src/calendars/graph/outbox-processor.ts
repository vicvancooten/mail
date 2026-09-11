import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/client.js";
import { type CalendarOutboxRow, calendars, type SeriesRow, series } from "../../db/schema.js";
import { revertSeriesFromUpstreamSnapshot, writeRollback } from "../outbox-rollback.js";
import {
  claimOutboxEntry,
  deleteOutboxEntry,
  releaseOutboxForReauth,
  scheduleOutboxRetry,
} from "../outbox-store.js";
import { type GraphCalendarClient, GraphCalendarWriteError, type GraphEvent } from "./client.js";
import { buildGraphEventBody, GraphRecurrenceUntranslatableError } from "./event-body.js";

/**
 * One outbox row's whole push to Microsoft Graph (#248) — `outbox-processor
 * .ts`'s own shape (claim, conflict-shape-3 check, push, snapshot, delete;
 * reject on anything else) reused verbatim; only *how a push actually talks
 * to the upstream* differs, which is exactly what this file, not that one,
 * owns. `outbox-loop.ts`'s per-row dispatch picks this over Google's own
 * `processOutboxEntry` by the owning Calendar's Connected Account provider.
 *
 * Two structural differences from Google's own push, both because Graph's
 * event model genuinely has no equivalent, not because this ticket chose to
 * skip one:
 *
 * - **No `If-Match`.** Graph's `event: update` reference never documents a
 *   conditional-write header (this ticket's own acceptance line: "`If-Match`
 *   on an event `PATCH` is undocumented"). So `pushToGraph` does what
 *   `google/client.ts#patchEvent`'s own `ifMatchEtag` exists to make
 *   unnecessary: an explicit `getEvent` immediately before the `PATCH`,
 *   comparing its live `changeKey` against `seriesRow.etag` and treating a
 *   mismatch as the same conflict a `412` would have been. **A lost update
 *   is still possible** in the gap between that `getEvent` and the `PATCH`
 *   landing — a genuine, narrower race than Google's own conditional header
 *   closes, and not one Wicket can detect after the fact (no Rollback fires
 *   for it, because nothing here ever sees it happen). That is the honest
 *   cost this ticket's own body names as "the reason the least is written
 *   there."
 * - **`restore` is always a fresh create.** Google's own `restoreEvent` is a
 *   status flip (`status: "confirmed"` back onto the same event) because
 *   Google lets a cancelled event's `status` be un-set. Graph's `event:
 *   cancel` **deletes** the event outright ("moves the event to the Deleted
 *   Items folder" — its own documented behaviour, confirmed by Microsoft's
 *   reference, not merely a guess) — there is no PATCH-able `status` field
 *   to flip back on an event that no longer exists. So `restore` here always
 *   calls `insertEvent`, never `patchEvent`, regardless of what `upstreamId`
 *   still says; `cancel` always clears `upstreamId`/`etag` on success for
 *   the same reason — nothing is left upstream to condition a later write
 *   against.
 */
export async function processGraphOutboxEntry(
  db: Db,
  id: string,
  deps: {
    client: GraphCalendarClient;
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
    // A permanent delete raced this push — nothing left to push or revert.
    await deleteOutboxEntry(db, row.id);
    return;
  }

  // Conflict shape 3 (ADR-0025): a delta already moved this Series' `etag`
  // (Graph's own `changeKey`) since the row was (re)enqueued — no network
  // call needed to know this is a conflict.
  if (row.baseEtag !== null && seriesRow.etag !== row.baseEtag) {
    await reject(
      db,
      row,
      seriesRow,
      "Graph's copy of this event changed while the edit was still queued.",
    );
    return;
  }

  const [calendarRow] = await db.select().from(calendars).where(eq(calendars.id, row.calendarId));
  if (!calendarRow || calendarRow.connectedAccountId === null) {
    // Unmirrored, or the Calendar itself is gone, underneath the queued write — nothing to push.
    await deleteOutboxEntry(db, row.id);
    return;
  }
  const graphCalendarId = calendarRow.id.slice(`gcal-ms:${calendarRow.connectedAccountId}:`.length);

  try {
    const pushed = await pushToGraph(
      deps.client,
      deps.accessToken,
      graphCalendarId,
      row,
      seriesRow,
    );
    if (pushed) {
      await db
        .update(series)
        .set({
          upstreamId: pushed.id,
          etag: pushed.changeKey,
          upstreamSnapshot: snapshotOf(seriesRow, pushed),
        })
        .where(eq(series.id, seriesRow.id));
    } else if (row.operation === "respond") {
      // `pushToGraph` already sent the accept/decline/tentativelyAccept
      // action, with no event body to snapshot from — `series.attendees`
      // was already the answer's own write (`series-store.ts
      // #answerInvitation`), and `upstreamId`/`etag` name the same event
      // either way, so nothing here needs updating.
    } else if (row.operation === "cancel") {
      await db
        .update(series)
        .set({ upstreamId: null, etag: null })
        .where(eq(series.id, seriesRow.id));
    }
    await deleteOutboxEntry(db, row.id);
  } catch (err) {
    if (err instanceof GraphRecurrenceUntranslatableError) {
      // "Nothing untranslatable is written" (this ticket's own acceptance
      // line): never attempted the network call at all — same terminal
      // rejection shape as a permanent write error.
      await reject(db, row, seriesRow, err.message);
      return;
    }
    if (!(err instanceof GraphCalendarWriteError)) throw err;

    if (err.kind === "needsReauth") {
      await releaseOutboxForReauth(db, row, now);
      return;
    }
    if (err.kind === "conflict") {
      await reject(db, row, seriesRow, "Graph rejected this change: its copy has moved on.");
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

async function pushToGraph(
  client: GraphCalendarClient,
  accessToken: string,
  graphCalendarId: string,
  row: CalendarOutboxRow,
  seriesRow: SeriesRow,
): Promise<GraphEvent | null> {
  if (row.operation === "cancel") {
    if (!seriesRow.upstreamId) {
      // Never pushed upstream at all (a create raced by a trash) — nothing to cancel.
      return null;
    }
    await client.cancelEvent(accessToken, seriesRow.upstreamId);
    return null; // `event: cancel` has no response body to snapshot from.
  }

  if (row.operation === "respond") {
    // Never queued with no upstream event to answer — `answerInvitation`
    // (#240) only ever enqueues this against a Series `mirrored`/writable
    // enough to have one; if the Event vanished from under a very slow
    // retry, there's nothing left to answer.
    if (!seriesRow.upstreamId || !row.responseStatus || row.responseStatus === "needsAction") {
      return null;
    }
    await client.respondToEvent(
      accessToken,
      seriesRow.upstreamId,
      graphResponseAction(row.responseStatus),
    );
    return null; // The action endpoints have no response body to snapshot from.
  }

  if (row.operation === "restore") {
    // Always a fresh create — see this file's own doc comment for why
    // Graph has no PATCH-based un-cancel to mirror Google's own status flip.
    return client.insertEvent(accessToken, graphCalendarId, buildGraphEventBody(seriesRow));
  }

  // "upsert"
  const body = buildGraphEventBody(seriesRow);
  if (!seriesRow.upstreamId) {
    return client.insertEvent(accessToken, graphCalendarId, body);
  }

  // Compare `changeKey` before writing rather than trusting a `412` Graph
  // does not document (this file's own doc comment, this ticket's own
  // acceptance line).
  if (seriesRow.etag !== null) {
    const current = await client.getEvent(accessToken, seriesRow.upstreamId);
    if (current.changeKey !== seriesRow.etag) {
      throw new GraphCalendarWriteError(
        "conflict",
        0,
        "changeKey moved since this Series was last synced (pre-write compare, no HTTP status of its own)",
      );
    }
  }
  return client.patchEvent(accessToken, seriesRow.upstreamId, body);
}

/** `SeriesAttendee["responseStatus"]` → Graph's own action name (#240) — `"needsAction"` is deliberately not a case here: `pushToGraph`'s own `respond` guard above never calls this with it (Graph has no un-respond action to call). */
function graphResponseAction(
  responseStatus: "accepted" | "declined" | "tentative",
): "accept" | "decline" | "tentativelyAccept" {
  if (responseStatus === "accepted") return "accept";
  if (responseStatus === "declined") return "decline";
  return "tentativelyAccept";
}

/** What a successful push leaves behind on `series` — `outbox-processor.ts#snapshotOf`'s own reasoning: the local fields just pushed, since a successful push is by definition what upstream now holds. */
function snapshotOf(seriesRow: SeriesRow, pushed: GraphEvent): Record<string, unknown> {
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
    etag: pushed.changeKey,
  };
}

async function reject(
  db: Db,
  row: CalendarOutboxRow,
  seriesRow: SeriesRow,
  reason: string,
): Promise<void> {
  await revertSeriesFromUpstreamSnapshot(db, seriesRow);
  await writeRollback(db, { userId: row.userId, entityId: row.seriesId, reason });
  await deleteOutboxEntry(db, row.id);
}
