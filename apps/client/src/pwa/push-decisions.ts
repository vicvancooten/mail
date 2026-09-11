import {
  type ConnectedAccountFacetKind,
  type PushPayload,
  pushPayloadSchema,
  type SnoozeUntil,
} from "@mail/shared";
import { FACET_LABEL } from "../connected-accounts/provider-table.js";

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
      // #204: names the Facet that parked, Mail included — a Calendar or
      // Contacts Facet needing reconnection reads differently from "needs
      // your password again", which is only ever literally true for Mail's
      // own IMAP/SMTP credential or a CalDAV/CardDAV account's shared one.
      return {
        title: "Reconnect your account",
        body:
          payload.facet === "mail"
            ? `${payload.emailAddress} needs your password again.`
            : `${FACET_LABEL[payload.facet]} for ${payload.emailAddress} needs reconnecting.`,
        tag: `mail-needs-reauth-${payload.connectedAccountId}-${payload.facet}`,
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
    case "calendar_reminder": {
      // "Two Reminders on one Occurrence fire separately and share a
      // notification tag, so the later replaces the earlier on the device"
      // (ADR-0028) — tagging on the first (only, in the common case)
      // Occurrence's own id is what gives a same-Occurrence pair that
      // replacement; a genuine multi-Occurrence group (several due the same
      // minute) still needs one tag, so it takes the earliest-fired entry's.
      const [first] = payload.events;
      return {
        title: first?.title ?? "Reminder",
        body: payload.events.map((event) => event.body).join("\n"),
        tag: `calendar-reminder-${first?.eventId ?? "group"}`,
        // "Snooze is the one action: a fixed 5 minutes as the OS
        // notification's button (Android and desktop; iOS has none)"
        // (ADR-0028) — Chrome/Android-only per this type's own doc comment,
        // silently ignored everywhere else, so no platform branch is needed
        // here either.
        actions: [{ action: "snooze", title: "Snooze 5 min" }],
      };
    }
    case "calendar_answer":
      // "Answers arriving for Events the User organises" (#243): the
      // notification names the Event, several Answers coalesced
      // (`notifier/record.ts`'s own doc comment) reading as one list in the
      // order they were folded into the payload's own `answers[]`.
      return {
        title: payload.title,
        body: describeAnswers(payload.answers),
        tag: `calendar-answer-${payload.eventId}`,
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

const RESPONSE_STATUS_VERB: Record<"accepted" | "declined" | "tentative", string> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentatively accepted",
};

/** "Ada accepted" / "Ada accepted; Grace declined" — never a bare count, recognizing a name is the point. */
function describeAnswers(
  answers: readonly {
    attendeeName: string | null;
    attendeeEmail: string;
    responseStatus: "accepted" | "declined" | "tentative";
  }[],
): string {
  if (answers.length === 0) return "An Attendee answered.";
  return answers
    .map(
      (answer) =>
        `${answer.attendeeName ?? answer.attendeeEmail} ${RESPONSE_STATUS_VERB[answer.responseStatus]}`,
    )
    .join("; ");
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
 * every kind focuses/opens the one window this Client runs (`AppShell`
 * mounts one `Router`, `router/routes.tsx`), and four kinds additionally
 * name what to land on inside it, so the focused window can route there
 * (ADR-0015: "a click always lands where the next decision is"):
 *
 * - `new_mail` names the Thread to select.
 * - `failed_send` names the Composition to reopen — the restored Draft in
 *   the composer, per ADR-0015.
 * - `needs_reauth` names the Facet cell whose settings/reauth form to jump
 *   to (#204: `connectedAccountId`+`facet`, not `mailAccountId` — a
 *   Calendar or Contacts Facet has no Mail Account to name).
 * - `gatekeeper_digest` deep-links to the Screener (ADR-0015: "a coalesced
 *   digest carries no actions — it deep-links to the Screener, since the
 *   sender is ambiguous"), scoped to the Mail Account it held mail for.
 *
 * `new_mail_burst` stays `focus-only`: it's a coalesced *Inbox* digest, not
 * a Gatekeeper hold — there is no single stranger's decision waiting on it,
 * so it falls back to the plain focus a click always gets at minimum.
 *
 * `calendar_reminder` (#246, ADR-0028: "tapping opens the Event in an
 * existing window... a group lands on the Day view at the earliest start")
 * names the first event's own id — the payload's own `events[]` doc comment
 * already establishes that a group's first entry is the earliest-due one.
 * `calendar_answer` (#243) opens the Event named, the same click target,
 * with no `reminderDueId` of its own since an Answer fires no Snooze row.
 */
export type NotificationClickTarget =
  | { kind: "thread"; mailAccountId: string; threadId: string }
  | { kind: "failed-send"; mailAccountId: string; compositionId: string }
  | { kind: "needs-reauth"; connectedAccountId: string; facet: ConnectedAccountFacetKind }
  | { kind: "screener"; mailAccountId: string }
  | { kind: "calendar-event"; eventId: string; reminderDueIds: string[] }
  | { kind: "focus-only" };

export function notificationClickTarget(payload: PushPayload): NotificationClickTarget {
  switch (payload.kind) {
    case "new_mail":
      return { kind: "thread", mailAccountId: payload.mailAccountId, threadId: payload.threadId };
    case "failed_send":
      return {
        kind: "failed-send",
        mailAccountId: payload.mailAccountId,
        compositionId: payload.compositionId,
      };
    case "needs_reauth":
      return {
        kind: "needs-reauth",
        connectedAccountId: payload.connectedAccountId,
        facet: payload.facet,
      };
    case "gatekeeper_digest":
      return { kind: "screener", mailAccountId: payload.mailAccountId };
    case "calendar_reminder": {
      const [first] = payload.events;
      if (!first) return { kind: "focus-only" };
      return {
        kind: "calendar-event",
        eventId: first.eventId,
        reminderDueIds: payload.events.map((event) => event.reminderDueId),
      };
    }
    case "calendar_answer":
      return { kind: "calendar-event", eventId: payload.eventId, reminderDueIds: [] };
    default:
      return { kind: "focus-only" };
  }
}

/**
 * The cold-start half of #151: with no window already open, there is no
 * `postMessage` recipient to hand a `NotificationClickTarget` to (nothing
 * has mounted/subscribed yet), so the target has to ride the URL
 * `self.clients.openWindow` opens instead — `router/routes.tsx`'s own
 * shape for "Mail with a Thread selected", the Screener, and Mail Accounts
 * settings. `account` is `/mail`'s own extra search param (`MailRoute.tsx`):
 * Account Scope is a Device Preference, not part of the URL, so a Thread or
 * Screener a previously-narrowed Scope would hide still needs a way to
 * widen it on a fresh mount — see `MailSection.tsx`'s `initialAccountId`.
 *
 * `failed-send` has no deep-link here — reopening a Draft in the composer
 * from a cold start is real, separate work this ticket didn't ask for; it
 * falls back to the default route, same as `focus-only`.
 */
export function notificationTargetUrl(target: NotificationClickTarget): string {
  switch (target.kind) {
    case "thread":
      return `/mail?thread=${encodeURIComponent(target.threadId)}&account=${encodeURIComponent(target.mailAccountId)}`;
    case "screener":
      return `/mail?folder=screener&account=${encodeURIComponent(target.mailAccountId)}`;
    case "needs-reauth":
      // #204: `account`/`facet` — `connected-accounts/account-focus.ts`'s own
      // query param names, read back by `ConnectedAccountsPage` once
      // `/settings/mail-accounts`'s own redirect (`routes.tsx`) lands there.
      return `/settings/mail-accounts?account=${encodeURIComponent(target.connectedAccountId)}&facet=${encodeURIComponent(target.facet)}`;
    // #246: `calendarEventRoute`'s own path segment is the Event's own id
    // (`<seriesId>@<originalStart>`, `router/routes.tsx`'s own doc comment)
    // — `reminderDueIds` rides no further than the warm-start
    // `NotificationTarget` above, a cold start has no Event page mounted
    // yet to hand a Snooze row's own id to.
    case "calendar-event":
      return `/calendar/${encodeURIComponent(target.eventId)}`;
    case "failed-send":
    case "focus-only":
      return "/";
  }
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

/**
 * The direct-POST body for the OS notification's Snooze button (#246,
 * ADR-0028): "posted to the existing notification-actions endpoint with an
 * idempotency key and Background Sync retry exactly as Archive is." User-
 * scoped, unlike Archive — `mailAccountId` is always `null`, a Reminder Due
 * row has none. The OS button always snoozes 5 minutes; the toast and Event
 * page's own longer/at-start choices post through the normal Optimistic
 * Action queue instead (`user-mutation-queue.ts`), not this direct path.
 */
export interface SnoozeActionRequest {
  id: string;
  mailAccountId: null;
  intent: { type: "snoozeReminder"; reminderDueIds: string[]; snoozeUntil: SnoozeUntil };
}

export function buildSnoozeActionRequest(
  reminderDueIds: string[],
  ulid: string,
): SnoozeActionRequest {
  return {
    id: ulid,
    mailAccountId: null,
    intent: {
      type: "snoozeReminder",
      reminderDueIds,
      snoozeUntil: { kind: "minutes", minutes: 5 },
    },
  };
}
