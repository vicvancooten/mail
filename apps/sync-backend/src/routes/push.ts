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
import { flushMutations } from "../sync/mutations.js";

export interface PushRoutesOptions {
  db: Db;
  /** `env.MAIL_VAPID_PUBLIC_KEY` — `null` when the operator has never run `generate-vapid-keys` (#53, ADR-0015). */
  vapidPublicKey: string | null;
}

/**
 * Web Push's device-registration routes plus the one direct-apply
 * notification action (#53, ADR-0015). Everything here is auth-gated the
 * same as every other route — a subscription/action is only ever read or
 * written for `request.user`.
 */
export async function pushRoutes(app: FastifyInstance, { db, vapidPublicKey }: PushRoutesOptions) {
  // Read by the settings screen to decide whether to offer "enable
  // notifications on this device" at all — an instance that never generated
  // a VAPID keypair simply doesn't have the feature, rather than failing.
  app.get("/push/config", { preHandler: app.requireAuth }, async () => {
    return pushConfigResponseSchema.parse({ vapidPublicKey });
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
    await deletePushSubscriptionByEndpoint(db, body.data.endpoint);
    return reply.code(204).send();
  });

  // `POST /notifications/actions` (ADR-0015: "Notification actions ... POST
  // direct ... never through the overlay") — the service worker's Archive
  // button posts here instead of enqueuing into the Client's local
  // pending-mutation queue, which a service worker has no leader tab to
  // drain. Reuses `flushMutations`'s idempotency ledger directly: the same
  // `id` retried by a Background Sync replay is a no-op, not a double-archive.
  app.post("/notifications/actions", { preHandler: app.requireAuth }, async (request, reply) => {
    const body = notificationActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    }
    const { id, mailAccountId, intent } = body.data;
    const account = await getMailAccountForUser(db, requireUser(request).id, mailAccountId);
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
  });
}

function requireUser(request: { user: { id: string } | null }): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
