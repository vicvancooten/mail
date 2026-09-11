import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calendars, events } from "../../db/schema.js";
import { computeEventWindow } from "../event-store.js";
import {
  type GoogleCalendarClient,
  type GoogleEvent,
  type GoogleEventDateTime,
  GoogleSyncTokenExpiredError,
} from "./client.js";

export interface SyncGoogleCalendarEventsParams {
  db: Db;
  userId: string;
  calendarId: string;
  client: GoogleCalendarClient;
  accessToken: string;
  googleCalendarId: string;
  now?: Date;
}

/**
 * `events.list` incremental sync (#234's own acceptance line): walks every
 * page under the stored `syncToken`, upserting each into the Event mirror,
 * and persists the new `syncToken` `events.list` hands back on the final
 * page. A `410 Gone` — the token expired — drops it and re-lists the whole
 * Event Window fresh, upserting into the same rows: "never `reset: true`",
 * so from the Client's own delta-sync cursor this looks like an ordinary
 * (if unusually large) batch of updates, not a wipe.
 */
export async function syncGoogleCalendarEvents(
  params: SyncGoogleCalendarEventsParams,
): Promise<void> {
  const {
    db,
    userId,
    calendarId,
    client,
    accessToken,
    googleCalendarId,
    now = new Date(),
  } = params;

  const [calendarRow] = await db
    .select({ googleSyncToken: calendars.googleSyncToken })
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .limit(1);
  const storedToken = calendarRow?.googleSyncToken ?? null;

  try {
    // No stored token means this is the very first sync of this mirrored
    // Calendar — Google requires an initial *bounded* list (the Event
    // Window) before it will hand back a `syncToken` to page incrementally
    // off of; a re-list after a 410 takes the exact same shape below.
    const window = storedToken ? undefined : computeEventWindow(now);
    await runEventSyncPages(params, storedToken ?? undefined, window);
  } catch (err) {
    if (!(err instanceof GoogleSyncTokenExpiredError)) throw err;
    // The stored token is gone — clear it before re-listing so a crash
    // mid-relist leaves the next tick doing a fresh full list too, rather
    // than retrying a token Google has already rejected once.
    await db.update(calendars).set({ googleSyncToken: null }).where(eq(calendars.id, calendarId));
    const window = computeEventWindow(now);
    await runEventSyncPages(
      { db, userId, calendarId, client, accessToken, googleCalendarId, now },
      undefined,
      window,
    );
  }
}

async function runEventSyncPages(
  params: SyncGoogleCalendarEventsParams,
  syncToken: string | undefined,
  window?: { start: Date; end: Date },
): Promise<void> {
  const { db, userId, calendarId, client, accessToken, googleCalendarId } = params;

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const page = await client.listEventsPage(accessToken, googleCalendarId, {
      syncToken,
      timeMin: syncToken ? undefined : window?.start.toISOString(),
      timeMax: syncToken ? undefined : window?.end.toISOString(),
      pageToken,
    });
    for (const item of page.items) {
      await upsertGoogleEvent(db, userId, calendarId, item);
    }
    pageToken = page.nextPageToken;
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) {
    await db
      .update(calendars)
      .set({ googleSyncToken: nextSyncToken })
      .where(eq(calendars.id, calendarId));
  }
}

/** `<seriesId>@<originalStart>` (ADR-0025, `packages/shared/src/events.ts`) — a singleton event is its own one-member series. */
function eventRowId(googleEvent: GoogleEvent): {
  id: string;
  seriesId: string;
  originalStart: Date;
} {
  const seriesId = googleEvent.recurringEventId ?? googleEvent.id;
  const originalStart = toDate(googleEvent.originalStartTime ?? googleEvent.start);
  return { id: `${seriesId}@${originalStart.toISOString()}`, seriesId, originalStart };
}

function toDate(dt: GoogleEventDateTime | undefined): Date {
  if (!dt) return new Date(0);
  return new Date(dt.dateTime ?? dt.date ?? 0);
}

async function upsertGoogleEvent(
  db: Db,
  userId: string,
  calendarId: string,
  googleEvent: GoogleEvent,
): Promise<void> {
  const { id, seriesId, originalStart } = eventRowId(googleEvent);
  const allDay = Boolean(googleEvent.start?.date) && !googleEvent.start?.dateTime;
  const startAt = toDate(googleEvent.start);
  const endAt = toDate(googleEvent.end ?? googleEvent.start);
  const status = googleEvent.status === "cancelled" ? "cancelled" : "confirmed";

  const [existing] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  const values = {
    calendarId,
    seriesId,
    originalStart,
    startAt,
    endAt,
    allDay,
    title: googleEvent.summary ?? "",
    location: googleEvent.location ?? null,
    status: status as "confirmed" | "cancelled",
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(events).set(values).where(eq(events.id, id));
  } else {
    await db.insert(events).values({ id, userId, ...values });
  }
}
