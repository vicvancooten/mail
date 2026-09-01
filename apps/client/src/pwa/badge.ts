/**
 * The app-icon badge (#53, ADR-0015): unread Inbox threads, set from the
 * backend-supplied counter — never a local recount. Both writers (the
 * leader tab, from `sync-round.ts`, and the service worker's own push
 * handler, `sw.ts`) call this same idempotent `setAppBadge(n)` with the
 * server-computed absolute `n` — "two writers of an absolute value is safe
 * in a way two writers of a delta would never be."
 *
 * "A denied device does not badge": Web Push requires Notification
 * permission on every platform (research: `docs/research/0006` §2 — WebKit
 * shows a badge only when notifications are granted), so this checks
 * `Notification.permission` before ever calling the Badging API, rather
 * than letting a silent no-op stand in for that rule.
 */

/** The slice of `navigator` this needs — narrowed so a test double beats casting a fake `Navigator`. */
export interface BadgeHost {
  setAppBadge?(count: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

export interface SetBadgeCountOptions {
  navigator?: BadgeHost;
  /** `Notification.permission` — injected because jsdom (`pnpm test`) has no real `Notification` global. */
  permission?: NotificationPermission;
}

function defaultPermission(): NotificationPermission {
  return globalThis.Notification?.permission ?? "default";
}

/**
 * Sets (or clears, for `0`) the badge — a no-op wherever the Badging API
 * doesn't exist (most browsers outside Safari/Chrome installed-PWA contexts)
 * or notification permission isn't granted. Never throws: a badge is
 * cosmetic, and `setAppBadge` itself can reject in a browser that exposes
 * the method but refuses it for its own reasons.
 */
export async function setBadgeCount(
  count: number,
  { navigator = safeNavigator(), permission = defaultPermission() }: SetBadgeCountOptions = {},
): Promise<void> {
  if (!navigator || permission !== "granted") return;
  try {
    if (count > 0) await navigator.setAppBadge?.(count);
    else await navigator.clearAppBadge?.();
  } catch {
    // Best-effort, same posture as `device-preferences.ts`'s storage
    // wrappers — a badge that failed to update costs nothing worth
    // surfacing on a triage surface that is silent when healthy.
  }
}

function safeNavigator(): BadgeHost | undefined {
  return globalThis.navigator as BadgeHost | undefined;
}
