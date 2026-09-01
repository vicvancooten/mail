/**
 * Where a notification click lands, once it reaches an open window (#53,
 * ADR-0015). The service worker can only `postMessage` a focused/opened
 * client — it has no way to call into `MailSection`'s React state directly
 * — so this is the one place that message turns into "select this
 * Thread", the same module-scoped pub/sub shape `sync-loop.ts` uses for
 * `requestSyncNow`.
 */

export interface NotificationTarget {
  mailAccountId: string;
  threadId: string;
}

const listeners = new Set<(target: NotificationTarget) => void>();

/** `MailSection` calls this once, on mount. */
export function subscribeNotificationTarget(
  listener: (target: NotificationTarget) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `main.tsx`'s `navigator.serviceWorker` message listener calls this on a `notification-click` message naming a Thread. */
export function publishNotificationTarget(target: NotificationTarget): void {
  for (const listener of listeners) listener(target);
}
