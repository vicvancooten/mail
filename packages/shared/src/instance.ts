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
    /** The exact CLI invocation to fix it, shown only when `configured` is false *and* `canGenerate` is false — the same wording the boot-time log warning uses. */
    generateCommand: z.string(),
    /**
     * Whether this instance can mint the keypair itself, from the Instance
     * page (ADR-0015 as amended, #53): true whenever the operator has *not*
     * pinned `MAIL_VAPID_PUBLIC_KEY`/`MAIL_VAPID_PRIVATE_KEY` in the
     * environment, in which case the Sync Backend owns the keypair and
     * `POST /instance/vapid-keys` is the fix rather than a shell command.
     * False on an env-pinned instance, where a button would write a key the
     * environment then overrides on the next boot — there, the command is
     * still the honest answer.
     */
    canGenerate: z.boolean(),
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

/**
 * `POST /instance/vapid-keys` (ADR-0015 as amended): mints and stores the
 * instance's Web Push keypair when it has none, and answers with the public
 * half — the same value `GET /push/config` serves every Client. Never
 * replaces a keypair that already works: existing subscriptions are bound
 * to the key they were created under, so a silent re-mint would kill every
 * one of them, which is the exact failure the original decision was written
 * to avoid.
 *
 * `replaced` is true only in the one case a re-mint is the repair rather
 * than the damage: a stored keypair that can no longer be unsealed with the
 * instance's current `MAIL_CREDENTIAL_KEY`, which is already unusable for
 * signing. Devices then have to re-enable notifications, and the Client
 * says so.
 */
export const generateVapidKeysResponseSchema = z.object({
  publicKey: z.string(),
  replaced: z.boolean(),
});
export type GenerateVapidKeysResponse = z.infer<typeof generateVapidKeysResponseSchema>;
