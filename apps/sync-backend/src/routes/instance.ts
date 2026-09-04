import { generateVapidKeysResponseSchema, instanceInfoResponseSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import { GENERATE_VAPID_KEYS_COMMAND, getAppVersion, isSecureContext } from "../instance-info.js";
import type { VapidKeyStore } from "../notifier/vapid-keys.js";

export interface InstanceRoutesOptions {
  publicUrl: string;
  /**
   * Where the Web Push keypair lives (#53, ADR-0015 as amended) — the same
   * store `routes/push.ts` and the Notifier read, so "configured" here and
   * "the Client is offered notifications" can never disagree.
   */
  vapidKeys: VapidKeyStore;
  /** `env.MAIL_VERSION` (`compose.yaml`'s `${MAIL_VERSION:-edge}`), or `"dev"` outside Docker. */
  imageTag: string;
}

/**
 * The Owner-only Instance page's routes (#104): the facts — "running version
 * and image tag; Web Push configured yes/no with the exact generate command;
 * System Mailer configured yes/no; secure-context check on PUBLIC_URL" — and
 * the one repair the page offers, minting the Web Push keypair (ADR-0015 as
 * amended). Gated on `requireOwner` rather than `requireAuth`: a Member gets
 * no nav entry to this page at all (`SettingsLayout.tsx`), and these routes
 * are the backstop if one navigates here directly.
 */
export async function instanceRoutes(
  app: FastifyInstance,
  { publicUrl, vapidKeys, imageTag }: InstanceRoutesOptions,
) {
  app.get("/instance/health", { preHandler: app.requireOwner }, async () => {
    return instanceInfoResponseSchema.parse({
      version: getAppVersion(),
      imageTag,
      webPush: {
        configured: (await vapidKeys.readPublicKey()) !== null,
        generateCommand: GENERATE_VAPID_KEYS_COMMAND,
        canGenerate: vapidKeys.canGenerate,
      },
      // System Mailer (CONTEXT.md) has no implementation yet — always
      // unconfigured until it exists to configure.
      systemMailer: { configured: false },
      publicUrl: {
        value: publicUrl,
        isSecureContext: isSecureContext(publicUrl),
      },
    });
  });

  /**
   * "Generate keys" on the Instance page (ADR-0015 as amended). Idempotent
   * in the only direction that matters: a keypair already in force is
   * answered with itself rather than replaced, because every live
   * subscription is bound to the key it was created under and re-minting
   * would silently kill all of them — the exact failure the original
   * decision was written to avoid.
   *
   * The one re-mint (`repair`, `replaced: true` in the response) is a stored
   * keypair this instance can no longer unseal, which cannot sign anything
   * as it stands; the Client says devices will need to re-enable
   * notifications. `409` is an env-pinned instance, where the environment
   * would override whatever this wrote on the next boot.
   */
  app.post("/instance/vapid-keys", { preHandler: app.requireOwner }, async (_request, reply) => {
    if (!vapidKeys.canGenerate) {
      return reply.code(409).send({ error: "env_managed" });
    }
    const existing = await vapidKeys.ensure();
    if (existing) {
      return generateVapidKeysResponseSchema.parse({
        publicKey: existing.publicKey,
        replaced: false,
      });
    }
    const repaired = await vapidKeys.repair();
    if (!repaired) {
      // `ensure` found nothing and `repair` refused, which only happens if a
      // readable keypair appeared between the two — the caller's request is
      // already satisfied, so re-read rather than reporting a failure.
      const publicKey = await vapidKeys.readPublicKey();
      if (!publicKey) return reply.code(500).send({ error: "generation_failed" });
      return generateVapidKeysResponseSchema.parse({ publicKey, replaced: false });
    }
    return generateVapidKeysResponseSchema.parse({
      publicKey: repaired.publicKey,
      replaced: true,
    });
  });
}
