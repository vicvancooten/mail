import { z } from "zod";

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
 * The push-worthy kinds the Notifier fires (ADR-0015's "The Notifier"),
 * minus the coalesced Gatekeeper hold digest — "the Gatekeeper digest kind
 * lands with Gatekeeper" (#53's own ticket text), not this one.
 * `new_mail_burst` is the per-Mail-Account collapse (poc-scope.md: "past ~5
 * pushes in a short window, collapse into one 'N new messages'") — a
 * distinct kind rather than a `new_mail` with `count > 1`, so the service
 * worker's click routing (a single Thread vs. nowhere in particular to land)
 * never has to branch on which shape a `new_mail` payload happens to be.
 */
export const notificationKindSchema = z.enum([
  "new_mail",
  "new_mail_burst",
  "failed_send",
  "needs_reauth",
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
    mailAccountId: z.string(),
    emailAddress: z.string(),
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
export const notificationActionIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("archive"), threadId: z.string() }),
]);
export type NotificationActionIntent = z.infer<typeof notificationActionIntentSchema>;

export const notificationActionRequestSchema = z.object({
  id: z.string(),
  mailAccountId: z.string(),
  intent: notificationActionIntentSchema,
});
export type NotificationActionRequest = z.infer<typeof notificationActionRequestSchema>;

export const notificationActionResponseSchema = z.object({
  status: z.enum(["applied", "rejected"]),
  reason: z.string().optional(),
});
export type NotificationActionResponse = z.infer<typeof notificationActionResponseSchema>;
