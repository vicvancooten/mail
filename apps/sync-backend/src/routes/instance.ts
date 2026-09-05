import {
  generateVapidKeysResponseSchema,
  instanceInfoResponseSchema,
  PROVIDERS,
  type Provider,
  type ProviderHealth,
  providerMailAccountCountResponseSchema,
  providerRegistrationResponseSchema,
  saveProviderRegistrationRequestSchema,
} from "@mail/shared";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import {
  buildProviderRedirectUri,
  GENERATE_VAPID_KEYS_COMMAND,
  getAppVersion,
  isSecureContext,
} from "../instance-info.js";
import { deriveCredentialKey, sealSecret } from "../mail-accounts/credential-crypto.js";
import { markNeedsReauth } from "../mail-accounts/store.js";
import { recordNeedsReauthNotification } from "../notifier/record.js";
import type { VapidKeyStore } from "../notifier/vapid-keys.js";
import {
  countMailAccountsForProvider,
  countNeedsReauthMailAccountsForProvider,
  deleteProviderRegistration,
  getProviderRegistration,
  listMailAccountsForProvider,
  type ProviderRegistrationRow,
  upsertProviderRegistration,
} from "../provider-registrations/store.js";
import { parseProviderParam } from "./route-params.js";

export interface InstanceRoutesOptions {
  db: Db;
  publicUrl: string;
  /** `env.MAIL_CREDENTIAL_KEY` (ADR-0003) — seals/unseals a Provider Registration's client secret, same as a Mail Account's own credential. */
  mailCredentialKey: string;
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
 * Provider Health's status (#118, ADR-0021): honest about the gap ADR-0021
 * names — `registered_untested` until the first Grant refresh attempt of
 * either kind reports in, then `working`/`failing` from whether that latest
 * attempt (`lastRefreshAt`) carried an error, never from a probe. A
 * `withdrawn` refresh writes neither column (`grant-refresh.ts`), so a
 * Provider with every account parked in Needs Reauth still reads as
 * `working` off its last successful refresh rather than flipping to
 * `failing` for a fact this doesn't track.
 */
function providerStatus(
  registration: Pick<ProviderRegistrationRow, "lastRefreshAt" | "lastRefreshError"> | null,
): ProviderHealth["status"] {
  if (!registration) return "not_registered";
  if (!registration.lastRefreshAt) return "registered_untested";
  return registration.lastRefreshError ? "failing" : "working";
}

/**
 * The Owner-only Instance page's routes (#104, #115): the four running-
 * instance facts from #104, the one repair the page offers — minting the Web
 * Push keypair (ADR-0015 as amended) — plus ADR-0021's Provider Health and
 * Provider Registration CRUD, all under the same `/instance` prefix
 * (poc-scope.md: no new top-level route prefix). Every one of these is gated
 * on `requireOwner` rather than `requireAuth` — CONTEXT.md's "the one thing a
 * Member cannot fix" applies to reading Provider Health exactly as it does to
 * changing it, and a Member gets no nav entry to this page at all
 * (`SettingsLayout.tsx`) — these routes are the backstop if one navigates
 * here directly.
 */
export async function instanceRoutes(
  app: FastifyInstance,
  { db, publicUrl, mailCredentialKey, vapidKeys, imageTag }: InstanceRoutesOptions,
) {
  const key = deriveCredentialKey(mailCredentialKey);
  const limitOwnerWrites = (groupId: string, max: number) =>
    app.rateLimit({
      groupId,
      max,
      timeWindow: 60_000,
      keyGenerator: (request) => request.user?.id ?? request.ip,
    });

  async function buildProviderHealth(provider: Provider): Promise<ProviderHealth> {
    const [registration, mailAccountCount, needsReauthCount] = await Promise.all([
      getProviderRegistration(db, provider),
      countMailAccountsForProvider(db, provider),
      countNeedsReauthMailAccountsForProvider(db, provider),
    ]);
    return {
      provider,
      status: providerStatus(registration),
      redirectUri: buildProviderRedirectUri(publicUrl, provider),
      clientIdPreview: registration?.clientId ?? null,
      mailAccountCount,
      needsReauthCount,
      lastRefreshAt: registration?.lastRefreshAt?.toISOString() ?? null,
      lastRefreshError: registration?.lastRefreshError ?? null,
    };
  }

  app.get("/instance/health", { preHandler: app.requireOwner }, async () => {
    const providers = await Promise.all(PROVIDERS.map((provider) => buildProviderHealth(provider)));
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
      providers,
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
  app.post(
    "/instance/vapid-keys",
    { preHandler: [app.requireOwner, limitOwnerWrites("instance-vapid-keys", 5)] },
    async (_request, reply) => {
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
    },
  );

  // Save (#115): create-or-replace, no restart. Never echoes the secret back
  // — `buildProviderHealth` only ever reads `clientId` off the stored row.
  app.put(
    "/instance/providers/:provider",
    { preHandler: [app.requireOwner, limitOwnerWrites("instance-provider-save", 5)] },
    async (request, reply) => {
      const provider = parseProviderParam(request, reply);
      if (!provider) return reply;

      const body = saveProviderRegistrationRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
      }

      await upsertProviderRegistration(
        db,
        provider,
        body.data.clientId,
        sealSecret(body.data.clientSecret, provider, key),
      );

      return providerRegistrationResponseSchema.parse({
        provider: await buildProviderHealth(provider),
      });
    },
  );

  // Preview (#115, ADR-0021: "first tells the Owner how many Mail Accounts
  // will stop syncing") — read-only, no transition happens here.
  app.get(
    "/instance/providers/:provider/delete-preview",
    { preHandler: app.requireOwner },
    async (request, reply) => {
      const provider = parseProviderParam(request, reply);
      if (!provider) return reply;
      return providerMailAccountCountResponseSchema.parse({
        mailAccountCount: await countMailAccountsForProvider(db, provider),
      });
    },
  );

  // Confirm (#115, ADR-0021): parks every Mail Account on this Provider in
  // Needs Reauth via the existing atomic transition, then removes the
  // Registration. `markNeedsReauth`'s own conditional update means an
  // account already in Needs Reauth is skipped rather than re-notified —
  // "one notification each" is per genuine transition, not per account.
  app.delete(
    "/instance/providers/:provider",
    { preHandler: [app.requireOwner, limitOwnerWrites("instance-provider-delete", 5)] },
    async (request, reply) => {
      const provider = parseProviderParam(request, reply);
      if (!provider) return reply;

      const accounts = await listMailAccountsForProvider(db, provider);
      for (const account of accounts) {
        const transitioned = await markNeedsReauth(db, account.id);
        if (transitioned) await recordNeedsReauthNotification(db, transitioned);
      }
      await deleteProviderRegistration(db, provider);

      return providerMailAccountCountResponseSchema.parse({ mailAccountCount: accounts.length });
    },
  );
}
