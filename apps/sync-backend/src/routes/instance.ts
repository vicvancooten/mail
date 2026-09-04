import { instanceInfoResponseSchema } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import { GENERATE_VAPID_KEYS_COMMAND, getAppVersion, isSecureContext } from "../instance-info.js";

export interface InstanceRoutesOptions {
  publicUrl: string;
  /** `env.MAIL_VAPID_PUBLIC_KEY` — `null` when the operator has never run `generate-vapid-keys`. */
  vapidPublicKey: string | null;
  /** `env.MAIL_VERSION` (`compose.yaml`'s `${MAIL_VERSION:-edge}`), or `"dev"` outside Docker. */
  imageTag: string;
}

/**
 * The Owner-only Instance page's one route (#104): "running version and
 * image tag; Web Push configured yes/no with the exact generate command;
 * System Mailer configured yes/no; secure-context check on PUBLIC_URL" —
 * exactly those four facts, nothing else. Gated on `requireOwner` rather
 * than `requireAuth`: a Member gets no nav entry to this page at all
 * (`SettingsLayout.tsx`), and this route is the backstop if one navigates
 * here directly.
 */
export async function instanceRoutes(
  app: FastifyInstance,
  { publicUrl, vapidPublicKey, imageTag }: InstanceRoutesOptions,
) {
  app.get("/instance/health", { preHandler: app.requireOwner }, async () => {
    return instanceInfoResponseSchema.parse({
      version: getAppVersion(),
      imageTag,
      webPush: {
        configured: vapidPublicKey !== null,
        generateCommand: GENERATE_VAPID_KEYS_COMMAND,
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
}
