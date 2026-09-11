import { z } from "zod";
import { connectedAccountFacetKindSchema } from "./connected-accounts.js";

/**
 * Web Push & the Notifier (#53, ADR-0015, `docs/research/0006`). The wire
 * shapes below are shared by the Client (subscribing, parsing a push
 * payload inside the service worker) and the Sync Backend (storing a
 * subscription, building a payload at Notifier-fire time) — exactly the
 * seam every other collection in this package is for.
 */

/**
 * The W3C Push API's own `PushSubscriptionJSON.keys` shape, as the Client
 * hands it to the backend straight off `PushSubscription#toJSON()` after
 * `pushManager.subscribe()`. `endpoint` (below) is the subscription's real
 * identity — what a `404`/`410` from the push service prunes by — these two
 * are the ECDH/auth secret the backend encrypts a payload against so the
 * relaying push service only ever sees ciphertext.
 */
export const pushSubscriptionKeysSchema = z.object({
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});
export type PushSubscriptionKeys = z.infer<typeof pushSubscriptionKeysSchema>;

/**
 * `POST /push/subscriptions`: registers this device's subscription against
 * the signed-in **User** (ADR-0015 — never the Session, "a subscription
 * that dies with a 60-day cookie rotation is one that stops working
 * silently"). Idempotent on `endpoint`: re-registering the same endpoint
 * (a reload, a second tab) upserts rather than duplicating.
 */
export const registerPushSubscriptionRequestSchema = z.object({
  endpoint: z.url(),
  keys: pushSubscriptionKeysSchema,
});
export type RegisterPushSubscriptionRequest = z.infer<typeof registerPushSubscriptionRequestSchema>;

/** `DELETE /push/subscriptions`: the "disable on this device" path — an explicit unsubscribe, not just a permission revoke. */
export const unregisterPushSubscriptionRequestSchema = z.object({
  endpoint: z.url(),
});
export type UnregisterPushSubscriptionRequest = z.infer<
  typeof unregisterPushSubscriptionRequestSchema
>;

/**
 * `GET /push/config`: `vapidPublicKey` is `null` when the operator has never
 * run the `generate-vapid-keys` CLI command (ADR-0015 — generated, never
 * auto-created, "auto-generating into the database would silently
 * invalidate every subscription on a volume-restore mismatch"). Web Push is
 * then simply not offered — the settings control hides itself — rather than
 * failing closed the way `PUBLIC_URL`/`MAIL_CREDENTIAL_KEY` do, since unlike
 * those two this is an optional layer on top of an otherwise-working Client.
 */
export const pushConfigResponseSchema = z.object({
  vapidPublicKey: z.string().nullable(),
});
export type PushConfigResponse = z.infer<typeof pushConfigResponseSchema>;

/**
 * The push-worthy kinds the Notifier fires (ADR-0015's "The Notifier").
 * `new_mail_burst` is the per-Mail-Account collapse (poc-scope.md: "past ~5
 * pushes in a short window, collapse into one 'N new messages'") — a
 * distinct kind rather than a `new_mail` with `count > 1`, so the service
 * worker's click routing (a single Thread vs. nowhere in particular to land)
 * never has to branch on which shape a `new_mail` payload happens to be.
 *
 * `gatekeeper_digest` is the coalesced Gatekeeper hold notification, landing
 * with Gatekeeper (#55) exactly as #53 said it would. Held mail never fires
 * a `new_mail` push — that is the whole point of a Screening Hold — so this
 * is the *only* way a stranger's arrival ever reaches a closed device, and
 * poc-scope.md bounds it hard: one push naming the senders on the first
 * hold, then four hours of silence however many more arrive.
 */
export const notificationKindSchema = z.enum([
  "new_mail",
  "new_mail_burst",
  "failed_send",
  "needs_reauth",
  "gatekeeper_digest",
  "calendar_reminder",
  "calendar_answer",
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/**
 * A push payload's content (ADR-0015: "Payloads carry sender display name,
 * subject, and the stored Snippet... every push payload carries that
 * count", the badge). One discriminated variant per kind so the service
 * worker's `showNotification` call and its `notificationclick` routing ("a
 * click always lands where the next decision is") never guess at which
 * fields a kind actually carries.
 *
 * `badgeCount` rides every variant unconditionally, including the two that
 * don't change it (`failedSend`, `needsReauth`) — ADR-0015: "each push is a
 * free self-heal, and a sometimes-absent field is a handler branch for no
 * gain".
 */
export const pushPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new_mail"),
    mailAccountId: z.string(),
    threadId: z.string(),
    senderName: z.string().nullable(),
    senderAddress: z.string().nullable(),
    subject: z.string(),
    /** Null when the body hasn't been swept yet (ADR-0005's lazy bodies) — the notification still fires on subject/sender alone. */
    snippet: z.string().nullable(),
    badgeCount: z.int(),
  }),
  z.object({
    kind: z.literal("new_mail_burst"),
    mailAccountId: z.string(),
    count: z.int(),
    badgeCount: z.int(),
  }),
  z.object({
    kind: z.literal("failed_send"),
    mailAccountId: z.string(),
    compositionId: z.string(),
    subject: z.string(),
    /** The SMTP rejection verbatim (compose-spec §Send-time validation & failure) — the same text the Draft's own badge shows. */
    detail: z.string(),
    badgeCount: z.int(),
  }),
  z.object({
    kind: z.literal("needs_reauth"),
    /** Only set for the Mail Facet (#204) — a Calendar/Contacts Facet has no Mail Account to name. */
    mailAccountId: z.string().nullable(),
    /** The Connected Account this Facet belongs to, and which Facet parked (#204's own acceptance criterion: "the notification names the Facet"). Always set, Mail included. */
    connectedAccountId: z.string(),
    facet: connectedAccountFacetKindSchema,
    emailAddress: z.string(),
    badgeCount: z.int(),
  }),
  z.object({
    kind: z.literal("gatekeeper_digest"),
    mailAccountId: z.string(),
    /**
     * The held senders this digest names, best display name first
     * (poc-scope.md's "3 held: A, B, C"). Capped server-side — a digest that
     * names forty strangers is a wall of text, and the Screener is where the
     * actual list lives.
     */
    senders: z.array(z.string()),
    /** How many senders are held in total, which can exceed `senders.length` once the cap bites. */
    count: z.int(),
    badgeCount: z.int(),
  }),
  z.object({
    kind: z.literal("calendar_reminder"),
    /**
     * "One payload kind with `events[]`" (ADR-0028): a single Reminder due
     * is an array of length one, never a special-cased shape — a Reminder
     * group (several Occurrences due the same minute) is the same shape
     * with more entries. Title/body are already-formatted strings, computed
     * once by the reminder loop at recording time.
     */
    events: z.array(
      z.object({
        /** #246: the Reminder Due row this entry came from — the Snooze action's own target. */
        reminderDueId: z.string(),
        eventId: z.string(),
        seriesId: z.string(),
        title: z.string(),
        body: z.string(),
      }),
    ),
    badgeCount: z.int(),
  }),
  z.object({
    kind: z.literal("calendar_answer"),
    /**
     * "Answers arriving for Events the User organises" (#243): one payload
     * per Event, coalesced across however many Attendees answered inside the
     * coalescing window (`notifier/record.ts`'s own doc comment) — a lone
     * Answer is an array of length one, the same "no special-cased shape of
     * its own" posture `calendar_reminder.events[]` already takes.
     */
    eventId: z.string(),
    seriesId: z.string(),
    title: z.string(),
    answers: z.array(
      z.object({
        attendeeName: z.string().nullable(),
        attendeeEmail: z.string(),
        responseStatus: z.enum(["accepted", "declined", "tentative"]),
      }),
    ),
    badgeCount: z.int(),
  }),
]);
export type PushPayload = z.infer<typeof pushPayloadSchema>;

/**
 * `POST /notifications/actions` (ADR-0015: "Notification actions ... POST
 * direct with a ULID key ... never through the overlay"): a narrow, explicit
 * allowlist rather than the full `MutationIntent` union (`sync.ts`) — this
 * route bypasses the Client's local pending-mutation queue entirely (a
 * service worker has no UI, no leader tab, and no rollback to render), so
 * only the one action a mail notification actually offers a button for is
 * reachable through it. Applied through the same idempotency ledger
 * `sync/mutations.ts#flushMutations` already keeps, keyed by this request's
 * own `id` — a Background Sync retry of the same `id` replays rather than
 * double-archiving.
 */
/**
 * `snoozeReminder` (#246, ADR-0028) joins `archive` here for the same
 * reason: "the OS notification's button ... posted to the existing
 * notification-actions endpoint with an idempotency key and Background Sync
 * retry, exactly as Archive is." Unlike `archive` it is User-scoped, not
 * Mail-Account-scoped — a Reminder Due row has no Mail Account at all — so
 * `notificationActionRequestSchema` below makes `mailAccountId` optional
 * rather than adding a second route.
 *
 * `reminderDueIds` is plural: a grouped `calendar_reminder` push (several
 * Occurrences due the same minute) shares one notification and one Snooze
 * button, so tapping it snoozes every Reminder the notification named
 * (`push.ts`'s own `events[]` doc comment) rather than picking one
 * arbitrarily. `snoozeUntil` mirrors the toast/Event page's own choice: a
 * fixed offset (5/10/15 — the OS button always sends 5) or the Occurrence's
 * own start, resolved server-side (`reminder-due-store.ts#snoozeReminderDue`)
 * since only the Sync Backend knows the Home Time Zone an all-day/floating
 * Occurrence needs.
 */
export const snoozeUntilSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("minutes"),
    minutes: z.union([z.literal(5), z.literal(10), z.literal(15)]),
  }),
  z.object({ kind: z.literal("eventStart") }),
]);
export type SnoozeUntil = z.infer<typeof snoozeUntilSchema>;

export const notificationActionIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("archive"), threadId: z.string() }),
  z.object({
    type: z.literal("snoozeReminder"),
    reminderDueIds: z.array(z.string()).min(1),
    snoozeUntil: snoozeUntilSchema,
  }),
]);
export type NotificationActionIntent = z.infer<typeof notificationActionIntentSchema>;

export const notificationActionRequestSchema = z.object({
  id: z.string(),
  /** `null` for a User-scoped action (`snoozeReminder`) — only `archive` names a Mail Account. */
  mailAccountId: z.string().nullable(),
  intent: notificationActionIntentSchema,
});
export type NotificationActionRequest = z.infer<typeof notificationActionRequestSchema>;

export const notificationActionResponseSchema = z.object({
  status: z.enum(["applied", "rejected"]),
  reason: z.string().optional(),
});
export type NotificationActionResponse = z.infer<typeof notificationActionResponseSchema>;
