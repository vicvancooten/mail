import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "../../db/client.js";
import { calendars, events } from "../../db/schema.js";
import { computeEventWindow } from "../event-store.js";
import {
  type GraphCalendarClient,
  type GraphDateTimeZone,
  type GraphDeltaEntry,
  GraphDeltaExpiredError,
} from "./client.js";

export interface SyncGraphCalendarEventsParams {
  db: Db;
  userId: string;
  calendarId: string;
  client: GraphCalendarClient;
  accessToken: string;
  graphCalendarId: string;
  now?: Date;
}

/**
 * `calendarView/delta` incremental sync (#248, `google/event-sync.ts`'s own
 * shape): walks every page under the stored `@odata.deltaLink`, upserting
 * each item into the Event mirror, and persists whatever new `deltaLink` the
 * final page hands back. A `410 Gone` (`GraphDeltaExpiredError`) drops it and
 * re-lists the whole Event Window fresh, upserting into the same rows — the
 * same "never a Client-visible `reset: true`" contract Google's own re-list
 * keeps.
 *
 * **Needs live verification** (this ticket's own body and closing comment):
 * `calendarView/delta` is documented at v1.0 for the signed-in user's
 * *default* calendar (`GET /me/calendarView/delta`); this ticket calls the
 * per-calendar form (`GET /me/calendars/{id}/calendarView/delta`) for every
 * mirrored Calendar, default or not, and Microsoft's own reference material
 * does not spell out — the way it does for the default-calendar form — that
 * the non-default form carries the same v1.0 guarantee rather than being a
 * beta-only extension. This adapter is written against the documented v1.0
 * request/response shape either way (same query parameters, same
 * `@odata.nextLink`/`@odata.deltaLink` pair); if a live account shows the
 * non-default form actually needs `/beta`, only `client.ts#listCalendarViewDeltaPage`'s
 * base URL needs to change, nothing about this file's own logic.
 */
export async function syncGraphCalendarEvents(
  params: SyncGraphCalendarEventsParams,
): Promise<void> {
  const { db, calendarId, now = new Date() } = params;

  const [calendarRow] = await db
    .select({ graphDeltaLink: calendars.graphDeltaLink })
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .limit(1);
  const storedLink = calendarRow?.graphDeltaLink ?? null;

  try {
    const window = storedLink ? undefined : computeEventWindow(now);
    await runEventSyncPages(params, storedLink ?? undefined, window);
  } catch (err) {
    if (!(err instanceof GraphDeltaExpiredError)) throw err;
    // The stored link is gone — clear it before re-listing so a crash
    // mid-relist leaves the next tick doing a fresh full list too, rather
    // than retrying a link Graph has already rejected once.
    await db.update(calendars).set({ graphDeltaLink: null }).where(eq(calendars.id, calendarId));
    const window = computeEventWindow(now);
    await runEventSyncPages(params, undefined, window);
  }
}

async function runEventSyncPages(
  params: SyncGraphCalendarEventsParams,
  initialLink: string | undefined,
  window?: { start: Date; end: Date },
): Promise<void> {
  const { db, userId, calendarId, client, accessToken, graphCalendarId } = params;

  let link = initialLink;
  let nextDeltaLink: string | undefined;
  let firstCall = !initialLink;
  do {
    const page = await client.listCalendarViewDeltaPage(accessToken, graphCalendarId, {
      deltaLink: link,
      start: firstCall ? window?.start : undefined,
      end: firstCall ? window?.end : undefined,
    });
    firstCall = false;
    for (const item of page.items) {
      await upsertGraphEvent(db, userId, calendarId, item);
    }
    link = page.nextLink;
    if (page.deltaLink) nextDeltaLink = page.deltaLink;
  } while (link);

  if (nextDeltaLink) {
    await db
      .update(calendars)
      .set({ graphDeltaLink: nextDeltaLink })
      .where(eq(calendars.id, calendarId));
  }
}

/**
 * Graph's response never carries an offset/zone the client asked for unless
 * `Prefer: outlook.timezone` was sent (this client never sends it,
 * `client.ts`'s own doc comment) — every `start`/`end.timeZone` is `"UTC"` by
 * Graph's own documented default, so this is always a plain UTC parse in
 * practice; `dt.timeZone` is still passed through rather than hardcoded, so
 * a future `Prefer` header would keep working with no change here.
 */
function toDate(dt: GraphDateTimeZone | undefined): Date {
  if (!dt) return new Date(0);
  const parsed = DateTime.fromISO(dt.dateTime, { zone: dt.timeZone || "UTC" });
  return parsed.isValid ? parsed.toJSDate() : new Date(dt.dateTime);
}

/** `<seriesId>@<originalStart>` (ADR-0025) — `google/event-sync.ts#eventRowId`'s own shape; `seriesMasterId` is Graph's own `recurringEventId`. */
function eventRowId(item: GraphDeltaEntry): { id: string; seriesId: string; originalStart: Date } {
  const seriesId = item.seriesMasterId ?? item.id;
  const originalStart = item.originalStart ? new Date(item.originalStart) : toDate(item.start);
  return { id: `${seriesId}@${originalStart.toISOString()}`, seriesId, originalStart };
}

async function upsertGraphEvent(
  db: Db,
  userId: string,
  calendarId: string,
  item: GraphDeltaEntry,
): Promise<void> {
  if (item["@removed"]) {
    await handleRemovedEvent(db, calendarId, item.id);
    return;
  }

  const { id, seriesId, originalStart } = eventRowId(item);
  const allDay = Boolean(item.isAllDay);
  const startAt = toDate(item.start);
  const endAt = toDate(item.end ?? item.start);
  const status = item.isCancelled ? "cancelled" : "confirmed";

  const [existing] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  const values = {
    calendarId,
    seriesId,
    upstreamEventId: item.id,
    originalStart,
    startAt,
    endAt,
    allDay,
    title: item.subject ?? "",
    location: item.location?.displayName ?? null,
    status: status as "confirmed" | "cancelled",
    transparency: (item.showAs === "free" ? "transparent" : "opaque") as "opaque" | "transparent",
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(events).set(values).where(eq(events.id, id));
  } else {
    await db.insert(events).values({ id, userId, ...values });
  }
}

/**
 * A `@removed` delta entry (this file's own doc comment) carries only
 * Graph's own event id — no `start`/`seriesMasterId` to rebuild this row's
 * deterministic id from, so this looks the row up by `upstreamEventId`
 * instead (`db/schema.ts#events`'s own doc comment for that column).
 * Status-flips to `cancelled` rather than deleting the row outright, the
 * same "never hard-delete an Occurrence, only status-flip" precedent
 * Google's own upsert already keeps for a cancelled event — a Calendar this
 * instance never actually mirrored the removed event into (outside the
 * window, or a tick raced the removal) is a silent no-op, same as an
 * unrecognized Google `syncToken` gap.
 */
async function handleRemovedEvent(
  db: Db,
  calendarId: string,
  upstreamEventId: string,
): Promise<void> {
  await db
    .update(events)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(events.calendarId, calendarId), eq(events.upstreamEventId, upstreamEventId)));
}
