import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { sessions } from "../../db/schema.js";

/** `google/cadence.ts`'s own two cadence numbers, reused verbatim for CalDAV (#247: "cadence off `sessions.lastSeenAt`, all on the shared poll-loop helper"). */
export const CALDAV_ACTIVE_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const CALDAV_IDLE_POLL_INTERVAL_MS = 30 * 60 * 1000;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `google/cadence.ts#wasClientActiveRecently`'s own logic — duplicated per provider rather than shared, the same convention `graph/cadence.ts` already follows. */
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

/** The Event-sync poll interval for one User's CalDAV Connected Account. */
export async function caldavEventPollIntervalMs(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await wasClientActiveRecently(db, userId, now))
    ? CALDAV_ACTIVE_POLL_INTERVAL_MS
    : CALDAV_IDLE_POLL_INTERVAL_MS;
}
