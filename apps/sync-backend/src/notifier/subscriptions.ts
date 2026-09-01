import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type PushSubscriptionRow, pushSubscriptions } from "../db/schema.js";

/**
 * A Web Push subscription's CRUD (#53, ADR-0015) — see `db/schema.ts`'s
 * `pushSubscriptions` doc comment for why it's User-scoped and keyed on
 * `endpoint`.
 */

export interface UpsertPushSubscriptionInput {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Registers a device's subscription, upserting on `endpoint` (a reload, a second tab on the same install). */
export async function upsertPushSubscription(
  db: Db,
  input: UpsertPushSubscriptionInput,
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      id: randomUUID(),
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: input.userId, p256dh: input.p256dh, auth: input.auth },
    });
}

/** The explicit "disable on this device" path (`DELETE /push/subscriptions`) — a no-op if the endpoint is already gone. */
export async function deletePushSubscriptionByEndpoint(db: Db, endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

/** Every device subscribed for a User — "every subscribed device is pushed; you never know which one is in someone's hand" (ADR-0015). */
export async function listPushSubscriptionsForUser(
  db: Db,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
}

/** Pruning on the first `404`/`410` a push service ever returns for this endpoint (ADR-0015, RFC 8030 §6.2/§7.3). */
export async function deletePushSubscriptionById(db: Db, id: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}
