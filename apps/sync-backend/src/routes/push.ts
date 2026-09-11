import {
  notificationActionRequestSchema,
  notificationActionResponseSchema,
  pushConfigResponseSchema,
  registerPushSubscriptionRequestSchema,
  unregisterPushSubscriptionRequestSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import {
  deletePushSubscriptionByEndpoint,
  upsertPushSubscription,
} from "../notifier/subscriptions.js";
import { flushMutations, flushUserMutations } from "../sync/mutations.js";

export interface PushRoutesOptions {
  db: Db;
  /**
   * The instance's current VAPID public key, or `null` when it has none
   * (#53, ADR-0015 as amended). A reader rather than a value: since the
   * keypair can be minted from the Instance page while the process runs
   * (`notifier/vapid-keys.ts`), a value captured at boot would keep
   * answering `null` — and the Client reads this before it will even offer
   * to enable notifications.
   */
  readVapidPublicKey: () => Promise<string | null>;
}

/**
 * Web Push's device-registration routes plus the one direct-apply
 * notification action (#53, ADR-0015). Everything here is auth-gated the
 * same as every other route — a subscription/action is only ever read or
 * written for `request.user`.
 */
export async function pushRoutes(
  app: FastifyInstance,
  { db, readVapidPublicKey }: PushRoutesOptions,
) {
  // Read by the settings screen to decide whether to offer "enable
  // notifications on this device" at all — an instance that has no VAPID
  // keypair simply doesn't have the feature, rather than failing.
  app.get("/push/config", { preHandler: app.requireAuth }, async () => {
    return pushConfigResponseSchema.parse({ vapidPublicKey: await readVapidPublicKey() });
  });

  app.post("/push/subscriptions", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = registerPushSubscriptionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    await upsertPushSubscription(db, {
      userId: requireUser(request).id,
      endpoint: body.data.endpoint,
      p256dh: body.data.keys.p256dh,
      auth: body.data.keys.auth,
    });
    return reply.code(204).send();
  });

  // The explicit "disable on this device" path — an unsubscribe, not just a
  // permission revoke (permission has no programmatic "un-grant" at all).
  app.delete("/push/subscriptions", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = unregisterPushSubscriptionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    await deletePushSubscriptionByEndpoint(db, requireUser(request).id, body.data.endpoint);
    return reply.code(204).send();
  });

  // `POST /notifications/actions` (ADR-0015: "Notification actions ... POST
  // direct ... never through the overlay") — the service worker's Archive
  // and Snooze buttons both post here instead of enqueuing into the
  // Client's local pending-mutation queue, which a service worker has no
  // leader tab to drain. `archive` is Mail-Account-scoped and reuses
  // `flushMutations`'s idempotency ledger directly; `snoozeReminder` (#246,
  // ADR-0028) is User-scoped — a Reminder Due row has no Mail Account at
  // all — so it reuses `flushUserMutations`'s ledger instead. Either way,
  // the same `id` retried by a Background Sync replay is a no-op, not a
  // double-apply.
  app.post("/notifications/actions", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = notificationActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    const { id, mailAccountId, intent } = body.data;
    const userId = requireUser(request).id;

    if (intent.type === "archive") {
      if (!mailAccountId) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const account = await getMailAccountForUser(db, userId, mailAccountId);
      if (!account) {
        return reply.code(404).send({ error: "mail_account_not_found" });
      }
      const [outcome] = await flushMutations(db, mailAccountId, [{ id, intent }]);
      if (!outcome) {
        throw new Error("flushMutations returned no outcome for a single queued mutation");
      }
      return notificationActionResponseSchema.parse(
        outcome.reason
          ? { status: outcome.status, reason: outcome.reason }
          : { status: outcome.status },
      );
    }

    const [outcome] = await flushUserMutations(db, userId, [{ id, intent }]);
    if (!outcome) {
      throw new Error("flushUserMutations returned no outcome for a single queued mutation");
    }
    return notificationActionResponseSchema.parse(
      outcome.reason
        ? { status: outcome.status, reason: outcome.reason }
        : { status: outcome.status },
    );
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
