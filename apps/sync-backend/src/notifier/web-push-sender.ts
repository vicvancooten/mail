import type { PushPayload } from "@mail/shared";
import webPush from "web-push";
import type { PushSubscriptionRow } from "../db/schema.js";
import type { SendPushFn } from "./deliver.js";
import type { VapidKeypair } from "./vapid-keys.js";

/**
 * The real `SendPushFn` (#53, ADR-0015): `web-push`'s own `sendNotification`
 * does the VAPID signing and payload encryption end to end — the relaying
 * push service only ever sees ciphertext either way. `main.ts` is the only
 * caller that wires this in; every test uses a plain fake instead of
 * touching a real push service (`deliver.test.ts`).
 *
 * The keypair arrives through `readKeypair` rather than as a value, because
 * since ADR-0015's amendment it can be minted *while the process is running*
 * (the Instance page's own button, `notifier/vapid-keys.ts`): reading it per
 * send is what lets the first push after that generation go out without a
 * restart. `null` means the instance has no keypair — nothing is sent, and
 * the failure is reported as transient rather than as an expired
 * subscription, since nothing about the subscription is wrong.
 */
export interface WebPushSenderOptions {
  readKeypair: () => Promise<VapidKeypair | null>;
  /** RFC 8292's "sub" claim — a `mailto:`/`https:` contact, `env.ts`'s `MAIL_VAPID_CONTACT`. */
  contact: string;
}

export function createWebPushSender({ readKeypair, contact }: WebPushSenderOptions): SendPushFn {
  return async (subscription: PushSubscriptionRow, payload: PushPayload) => {
    const keypair = await readKeypair();
    if (!keypair) return { ok: false, expired: false };
    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: contact,
            publicKey: keypair.publicKey,
            privateKey: keypair.privateKey,
          },
        },
      );
      return { ok: true };
    } catch (err) {
      // RFC 8030 §6.2/§7.3: a `404`/`410` is the standard, documented way a
      // push service signals a subscription that no longer exists — pruned
      // on the first sighting (ADR-0015), everything else treated as
      // transient and left for the next delivery tick to retry.
      const status = err instanceof webPush.WebPushError ? err.statusCode : undefined;
      return { ok: false, expired: status === 404 || status === 410 };
    }
  };
}
