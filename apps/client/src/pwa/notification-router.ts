import type { ConnectedAccountFacetKind } from "@mail/shared";

/**
 * Where a notification click lands, once it reaches an open window (#53,
 * ADR-0015). The service worker can only `postMessage` a focused/opened
 * client — it has no way to call into `MailSection`'s React state directly
 * — so this is the one place that message turns into "select this Thread /
 * reopen this Draft / jump to this Mail Account's settings / open the
 * Screener", the same module-scoped pub/sub shape `sync-loop.ts` uses for
 * `requestSyncNow`.
 *
 * Mirrors `push-decisions.ts#NotificationClickTarget` one-for-one, minus
 * `focus-only` — a click with nothing narrower to land on than the window
 * itself never reaches this module at all.
 */

export type NotificationTarget =
  | { kind: "thread"; mailAccountId: string; threadId: string }
  | { kind: "failed-send"; mailAccountId: string; compositionId: string }
  /** Widened by #204: `connectedAccountId`+`facet` name which Facet cell to
   * open — every `needs_reauth` push carries both now, Mail Facet included,
   * so this never needs `mailAccountId` to resolve a click. */
  | { kind: "needs-reauth"; connectedAccountId: string; facet: ConnectedAccountFacetKind }
  | { kind: "screener"; mailAccountId: string }
  /**
   * A `calendar_reminder` click (#246, ADR-0028: "tapping opens the Event
   * in an existing window"). `reminderDueIds` rides along purely so the
   * Event page can offer its own Snooze row for *this* fired Reminder —
   * "fired... state is server-side only; the Client never syncs it"
   * (ADR-0028) means there is no other way for the page to learn a
   * Reminder just fired for the Event it's opening.
   */
  | { kind: "calendar-event"; eventId: string; reminderDueIds: string[] };

const listeners = new Set<(target: NotificationTarget) => void>();
const startedContainers = new WeakSet<MessageContainer>();

/** `MailSection` calls this once, on mount. */
export function subscribeNotificationTarget(
  listener: (target: NotificationTarget) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `startNotificationRouter`'s own `navigator.serviceWorker` message listener calls this on a `notification-click` message naming a target. */
export function publishNotificationTarget(target: NotificationTarget): void {
  for (const listener of listeners) listener(target);
}

interface NotificationClickMessage {
  type: "notification-click";
  target: NotificationTarget;
}

function isNotificationTarget(data: unknown): data is NotificationTarget {
  if (typeof data !== "object" || data === null) return false;
  const target = data as {
    kind?: unknown;
    mailAccountId?: unknown;
    threadId?: unknown;
    compositionId?: unknown;
    connectedAccountId?: unknown;
    facet?: unknown;
    eventId?: unknown;
    reminderDueIds?: unknown;
  };
  switch (target.kind) {
    case "thread":
      return typeof target.mailAccountId === "string" && typeof target.threadId === "string";
    case "failed-send":
      return typeof target.mailAccountId === "string" && typeof target.compositionId === "string";
    case "screener":
      return typeof target.mailAccountId === "string";
    case "needs-reauth":
      // Widened by #204: keyed by Connected Account + Facet, not a Mail
      // Account (this type's own doc comment above).
      return typeof target.connectedAccountId === "string" && typeof target.facet === "string";
    case "calendar-event":
      return (
        typeof target.eventId === "string" &&
        Array.isArray(target.reminderDueIds) &&
        target.reminderDueIds.every((id) => typeof id === "string")
      );
    default:
      return false;
  }
}

/** Narrowed rather than typed against the untrusted `MessageEvent.data` directly — the same posture `NewMailToast.tsx`'s own message guard takes. */
function isNotificationClickMessage(data: unknown): data is NotificationClickMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "notification-click" &&
    isNotificationTarget((data as { target?: unknown }).target)
  );
}

/** The slice of `navigator.serviceWorker` this needs — narrowed so a test double beats faking the whole container (jsdom has none at all). */
export interface MessageContainer {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/**
 * The other half of `sw.ts#focusOrOpenClient`'s `existing.postMessage({type:
 * "notification-click", target})`: with no listener wired up, that message
 * had nowhere to arrive (#151 — the gap this closes). `main.tsx` calls this
 * once at startup, the same way it calls `registerServiceWorker()`; a no-op
 * wherever there's no `navigator.serviceWorker` at all (an old browser,
 * `vite dev` without HTTPS) — nothing here needs the registration itself,
 * only the container `postMessage` arrives on.
 */
export function startNotificationRouter(
  container: MessageContainer | undefined = globalThis.navigator?.serviceWorker,
): void {
  if (!container) return;
  if (startedContainers.has(container)) return;
  startedContainers.add(container);
  container.addEventListener("message", (event) => {
    if (!isNotificationClickMessage(event.data)) return;
    publishNotificationTarget(event.data.target);
  });
}
