/**
 * Closing a stale notification cross-device on `\Seen` (#53, ADR-0015):
 * "Notifications are tagged with their thread id, so any delta marking the
 * thread `\Seen` lets the service worker close stale notifications on other
 * devices via `getNotifications({tag})`." The trigger is
 * `server-writes.ts#applyThreadDelta` — whichever device's leader tab next
 * pulls a delta naming this Thread with `unreadCount` back at zero closes
 * its own OS notification for it, exactly as stale here as it would be on
 * "another" device. `mail-thread-${threadId}` is the same tag
 * `push-decisions.ts#buildNotificationContent` gives a `new_mail`
 * notification, so this only ever matches a notification for *this*
 * Thread.
 */

/** The slice of `ServiceWorkerRegistration` this needs — narrowed so a test double beats faking the whole thing (jsdom has none at all). */
export interface NotificationRegistryLike {
  getNotifications(options: { tag: string }): Promise<{ close(): void }[]>;
}

function notificationTagForThread(threadId: string): string {
  return `mail-thread-${threadId}`;
}

async function defaultRegistry(): Promise<NotificationRegistryLike | undefined> {
  const sw = (globalThis.navigator as Navigator | undefined)?.serviceWorker;
  if (!sw) return undefined;
  try {
    return (await sw.ready) as unknown as NotificationRegistryLike;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort: no Service Worker at all (`vite dev`, jsdom under `pnpm
 * test`), no registration ready yet, or the platform simply has nothing
 * tagged this way — every one of those is "nothing to close", not an
 * error, same posture as `badge.ts#setBadgeCount`.
 */
export async function closeStaleThreadNotification(
  threadId: string,
  registry?: NotificationRegistryLike,
): Promise<void> {
  const target = registry ?? (await defaultRegistry());
  if (!target) return;
  try {
    const notifications = await target.getNotifications({
      tag: notificationTagForThread(threadId),
    });
    for (const notification of notifications) notification.close();
  } catch {
    // Cosmetic cleanup — see this function's own doc comment.
  }
}
