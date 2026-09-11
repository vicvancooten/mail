import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calendars, events } from "../../db/schema.js";
import type { CaldavAuth, CaldavCalendarClient, CaldavObject, CaldavSyncResult } from "./client.js";
import { parseCaldavObject } from "./event-body.js";

export interface SyncCaldavCalendarEventsParams {
  db: Db;
  userId: string;
  calendarId: string;
  calendarHref: string;
  client: CaldavCalendarClient;
  auth: CaldavAuth;
}

/**
 * `sync-collection` incremental sync with a `getctag` fallback (#247's own
 * acceptance line): `getctag` is checked *first*, before ever issuing the
 * REPORT — unchanged since the last tick means nothing in this collection
 * moved, so the REPORT (and the `calendar-multiget` it would otherwise feed)
 * never runs at all this tick. A stale/invalid sync-token (`kind:
 * "staleToken"`, RFC 6578's own `403 valid-sync-token` precondition) drops it
 * and re-walks the whole collection fresh via an unconditioned `sync-
 * collection` call (which, with no token, RFC 6578 defines as returning
 * every current object) — upserting into the same rows, never a Client-
 * visible `reset: true`, `google/event-sync.ts`'s own `410` contract.
 */
export async function syncCaldavCalendarEvents(
  params: SyncCaldavCalendarEventsParams,
): Promise<void> {
  const { db, calendarId, calendarHref, client, auth } = params;

  const [calendarRow] = await db
    .select({ davCtag: calendars.davCtag, davSyncToken: calendars.davSyncToken })
    .from(calendars)
    .where(eq(calendars.id, calendarId))
    .limit(1);
  const storedCtag = calendarRow?.davCtag ?? null;
  const storedToken = calendarRow?.davSyncToken ?? null;

  if (storedToken) {
    const currentCtag = await client.getCtag(auth, calendarHref);
    if (currentCtag !== null && currentCtag === storedCtag) return; // nothing moved — the REPORT below never runs.
  }

  const result = await client.syncCollection(auth, calendarHref, storedToken ?? undefined);
  if (result.kind === "staleToken") {
    // The stored token is gone — clear it before re-walking so a crash
    // mid-walk leaves the next tick doing a fresh full walk too, rather than
    // retrying a token the server has already rejected once.
    await db.update(calendars).set({ davSyncToken: null }).where(eq(calendars.id, calendarId));
    const fresh = await client.syncCollection(auth, calendarHref, undefined);
    if (fresh.kind === "staleToken") return; // the server is unhealthy right now — next tick tries again.
    await applyChanges(params, fresh);
    return;
  }
  await applyChanges(params, result);
}

async function applyChanges(
  params: SyncCaldavCalendarEventsParams,
  result: Extract<CaldavSyncResult, { kind: "ok" }>,
): Promise<void> {
  const { db, userId, calendarId, calendarHref, client, auth } = params;

  if (result.changed.length > 0) {
    const objects = await client.multiget(
      auth,
      calendarHref,
      result.changed.map((entry) => entry.href),
    );
    for (const object of objects) {
      await upsertCaldavObject(db, userId, calendarId, object);
    }
  }

  for (const href of result.deletedHrefs) {
    // "Never hard-delete an Occurrence, only status-flip" — `graph/event-
    // sync.ts#handleRemovedEvent`'s own precedent for exactly this shape: a
    // deleted object names only its own href, with no `start`/series id to
    // rebuild this row's deterministic id from.
    await db
      .update(events)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(events.calendarId, calendarId), eq(events.upstreamEventId, href)));
  }

  const latestCtag = await client.getCtag(auth, calendarHref);
  await db
    .update(calendars)
    .set({ davSyncToken: result.syncToken || null, davCtag: latestCtag })
    .where(eq(calendars.id, calendarId));
}

/** `<seriesId>@<originalStart>` (ADR-0025) — `google/event-sync.ts#eventRowId`'s own shape; the `RECURRENCE-ID` override case is `event-body.ts#parseCaldavObject`'s own doc comment. */
function instanceRowId(uid: string, originalStart: Date): string {
  return `${uid}@${originalStart.toISOString()}`;
}

async function upsertCaldavObject(
  db: Db,
  userId: string,
  calendarId: string,
  object: CaldavObject,
): Promise<void> {
  const instances = parseCaldavObject(object.icsData);
  for (const instance of instances) {
    const originalStart = instance.recurrenceId ?? instance.start;
    const id = instanceRowId(instance.uid, originalStart);

    const [existing] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, id))
      .limit(1);
    const values = {
      calendarId,
      seriesId: instance.uid,
      upstreamEventId: object.href,
      originalStart,
      startAt: instance.start,
      endAt: instance.end,
      allDay: instance.allDay,
      title: instance.summary ?? "",
      location: instance.location ?? null,
      status: instance.status,
      transparency: instance.transparency,
      updatedAt: new Date(),
    };
    if (existing) {
      await db.update(events).set(values).where(eq(events.id, id));
    } else {
      await db.insert(events).values({ id, userId, ...values });
    }
  }
}
