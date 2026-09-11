import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calendarMirrorSyncState, calendarWatchChannels } from "../../db/schema.js";

/**
 * Google's `watch()` push notification (#234's own acceptance line: "a
 * `watch` notification only schedules an immediate poll; the poll remains
 * authoritative"). Google delivers no event payload, only the channel that
 * fired and its current `resourceState` header (`"sync"` on the
 * channel's own confirmation ping, `"exists"` on a real change) — so all
 * this does is look the channel up and, if it's still one this instance
 * knows about, stamp `pollRequestedAt` for that Connected Account. The next
 * `poll-loop.ts` tick reads that stamp and treats the account as due
 * regardless of its ordinary cadence; there is no separate "handle the
 * change" path here, because `watch` never carries the change itself.
 *
 * An unrecognized or already-expired channel is a silent no-op: Google
 * gives no interactive path to report a rejected notification on, and the
 * ordinary poll cadence still catches whatever changed either way.
 */
export async function handleGoogleCalendarPushNotification(
  db: Db,
  params: { channelId: string; resourceId: string },
): Promise<void> {
  const [channel] = await db
    .select()
    .from(calendarWatchChannels)
    .where(eq(calendarWatchChannels.channelId, params.channelId))
    .limit(1);
  if (!channel || channel.resourceId !== params.resourceId) return;
  if (channel.expiration.getTime() < Date.now()) return;

  await requestImmediatePoll(db, channel.connectedAccountId);
}

/** Stamps a Connected Account as due right now — `poll-loop.ts`'s own tick clears it once it acts on it. */
export async function requestImmediatePoll(db: Db, connectedAccountId: string): Promise<void> {
  await db
    .insert(calendarMirrorSyncState)
    .values({ connectedAccountId, pollRequestedAt: new Date() })
    .onConflictDoUpdate({
      target: calendarMirrorSyncState.connectedAccountId,
      set: { pollRequestedAt: new Date() },
    });
}
