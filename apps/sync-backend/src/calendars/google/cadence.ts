import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";

/** The ticket's own two cadence numbers: "5 minutes while a Client of the User was active in the last 24 hours, 30 minutes otherwise." */
export const CALENDAR_ACTIVE_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const CALENDAR_IDLE_POLL_INTERVAL_MS = 30 * 60 * 1000;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * "A Client of the User was active" (#234) is read off `sessions.lastSeenAt`
 * — it already "slides forward on use" on every authenticated request
 * (`auth/sessions.ts`), which is exactly what a Client polling or holding an
 * `/events` SSE connection open does. No new activity-tracking column: this
 * is the one signal the codebase already has for "somebody's actually
 * using this", and it's User-scoped (a session's `userId`) rather than
 * Connected-Account-scoped, matching the ticket's own "a Client of the
 * User", not "of the account".
 */
export async function wasClientActiveRecently(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.lastSeenAt, cutoff)))
    .limit(1);
  return row !== undefined;
}

/** The Event-sync poll interval for one User's Connected Account, per the ticket's cadence line. */
export async function calendarEventPollIntervalMs(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await wasClientActiveRecently(db, userId, now))
    ? CALENDAR_ACTIVE_POLL_INTERVAL_MS
    : CALENDAR_IDLE_POLL_INTERVAL_MS;
}
