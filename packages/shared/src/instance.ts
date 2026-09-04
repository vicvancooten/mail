import { z } from "zod";

/**
 * `GET /instance/health` (#104): the Owner-only Instance page's one data
 * source. Deliberately a *different* route from the unauthenticated
 * `/healthz` (`health.ts`) — this one carries facts an operator cares about
 * but a Member should never see and an unauthenticated prober certainly
 * shouldn't (`PUBLIC_URL`'s literal value, whether Web Push is configured),
 * so it sits behind `app.requireOwner` instead.
 *
 * Every field here is a yes/no or a label, never a secret — no key
 * material, no credentials — because the point of the page is "the Owner
 * learns from logs and the Instance page" (grill Q21/Q32), not a debug
 * dump.
 */
export const instanceInfoResponseSchema = z.object({
  /** `process.env.npm_package_version`, the same value `/healthz` reports. */
  version: z.string(),
  /** The image tag actually running (`compose.yaml`'s `${MAIL_VERSION:-edge}`) — `"dev"` outside Docker. */
  imageTag: z.string(),
  webPush: z.object({
    configured: z.boolean(),
    /** The exact CLI invocation to fix it, shown only when `configured` is false — the same wording the boot-time log warning uses. */
    generateCommand: z.string(),
  }),
  /** Always `false` at PoC — System Mailer (CONTEXT.md) has no implementation yet, only the domain term. */
  systemMailer: z.object({
    configured: z.boolean(),
  }),
  publicUrl: z.object({
    value: z.string(),
    /** `false` means `http://` on a non-localhost host: Web Push and passkeys will not work from other devices. */
    isSecureContext: z.boolean(),
  }),
});
export type InstanceInfoResponse = z.infer<typeof instanceInfoResponseSchema>;
