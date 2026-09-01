import { type PushPayload, pushPayloadSchema } from "@mail/shared";

/**
 * The pure decisions the service worker's `push`/`notificationclick`
 * handlers make (#53, ADR-0015), pulled out of `sw.ts` the same way
 * `shell-routing.ts` pulls its fetch-routing decisions out — jsdom (this
 * package's `pnpm test` environment) has no `PushEvent`/`Notification`
 * globals to run `sw.ts` itself against, but none of that is needed to test
 * *what* a push payload turns into.
 */

/** `event.data.json()` is untrusted input from the network — `safeParse`, never `parse`. */
export function parsePushPayload(data: unknown): PushPayload | null {
  const result = pushPayloadSchema.safeParse(data);
  return result.success ? result.data : null;
}

export interface NotificationContent {
  title: string;
  body: string;
  /** Notifications sharing a tag replace one another — this is also what `getNotifications({tag})` closes by, on `\Seen` (ADR-0015). */
  tag: string;
  /** Chrome/Android-only (ADR-0015, `docs/research/0006` §3) — silently ignored elsewhere, never relied on. */
  actions?: { action: string; title: string }[];
}

/**
 * One push payload's `showNotification` content. A coalesced digest
 * (`new_mail_burst`, `gatekeeper_digest`) carries **no actions** — the
 * sender is ambiguous, which is ADR-0015's own rule for the Gatekeeper
 * digest and reads the same way for a burst.
 */
export function buildNotificationContent(payload: PushPayload): NotificationContent {
  switch (payload.kind) {
    case "new_mail":
      return {
        title: payload.senderName ?? payload.senderAddress ?? "New mail",
        body: payload.snippet ? `${payload.subject}\n${payload.snippet}` : payload.subject,
        tag: `mail-thread-${payload.threadId}`,
        actions: [{ action: "archive", title: "Archive" }],
      };
    case "new_mail_burst":
      return {
        title: `${payload.count} new messages`,
        body: "Tap to open your Inbox.",
        tag: `mail-burst-${payload.mailAccountId}`,
      };
    case "failed_send":
      return {
        title: "Send failed",
        body: `${payload.subject}: ${payload.detail}`,
        tag: `mail-failed-send-${payload.compositionId}`,
      };
    case "needs_reauth":
      return {
        title: "Reconnect your account",
        body: `${payload.emailAddress} needs your password again.`,
        tag: `mail-needs-reauth-${payload.mailAccountId}`,
      };
    case "gatekeeper_digest":
      // "3 held: A, B, C" (poc-scope.md), with the tail elided once the
      // backend's cap bites. One tag per Mail Account, so a second digest
      // four hours later replaces the first rather than stacking — the
      // Screener, not the notification shade, is where the list lives.
      return {
        title: `${payload.count} held in the Screener`,
        body: describeHeldSenders(payload.senders, payload.count),
        tag: `mail-gatekeeper-${payload.mailAccountId}`,
      };
  }
}

/** "Ada, Grace and 2 more" — never the bare count on its own, since recognizing a name is the whole reason to look. */
function describeHeldSenders(senders: string[], count: number): string {
  if (senders.length === 0) return "Tap to review who's waiting.";
  const remaining = count - senders.length;
  const named = senders.join(", ");
  return remaining > 0 ? `${named} and ${remaining} more` : named;
}

/** The slice of `WindowClient` a suppression check needs — narrowed so a test double beats casting a fake. */
export interface VisibilityLike {
  visibilityState: string;
}

/**
 * "A visible window suppresses the OS notification in favour of the inline
 * toast" (ADR-0015) — the service worker's own decision, never the
 * server's (a dropped SSE connection would make server-side tracking
 * instantly wrong).
 */
export function hasVisibleClient(clients: readonly VisibilityLike[]): boolean {
  return clients.some((client) => client.visibilityState === "visible");
}

/**
 * What a click on the notification's body (no action button) should do:
 * every kind focuses/opens the one window this Client already stacks every
 * section into (`AppShell`'s own doc comment — "there is no router in this
 * Client"), and `new_mail` additionally names which Thread to land on, so
 * the focused window can select it. The other three kinds have nothing
 * further to route to: Needs Reauth's banner and a failed send's badge are
 * already visible on that one page once it's focused.
 */
export type NotificationClickTarget =
  | { kind: "thread"; mailAccountId: string; threadId: string }
  | { kind: "focus-only" };

export function notificationClickTarget(payload: PushPayload): NotificationClickTarget {
  if (payload.kind === "new_mail") {
    return { kind: "thread", mailAccountId: payload.mailAccountId, threadId: payload.threadId };
  }
  return { kind: "focus-only" };
}

/** The direct-POST body for the Archive action button — ADR-0015: "POST direct with a ULID key ... never through the overlay." */
export interface ArchiveActionRequest {
  id: string;
  mailAccountId: string;
  intent: { type: "archive"; threadId: string };
}

export function buildArchiveActionRequest(
  mailAccountId: string,
  threadId: string,
  ulid: string,
): ArchiveActionRequest {
  return { id: ulid, mailAccountId, intent: { type: "archive", threadId } };
}
