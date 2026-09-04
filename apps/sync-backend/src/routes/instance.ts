import {
  instanceInfoResponseSchema,
  PROVIDERS,
  type Provider,
  type ProviderHealth,
  providerMailAccountCountResponseSchema,
  providerRegistrationResponseSchema,
  providerSchema,
  saveProviderRegistrationRequestSchema,
} from "@mail/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
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
import {
  countMailAccountsForProvider,
  countNeedsReauthMailAccountsForProvider,
  deleteProviderRegistration,
  getProviderRegistration,
  listMailAccountsForProvider,
  upsertProviderRegistration,
} from "../provider-registrations/store.js";

export interface InstanceRoutesOptions {
  db: Db;
  publicUrl: string;
  /** `env.MAIL_CREDENTIAL_KEY` (ADR-0003) — seals/unseals a Provider Registration's client secret, same as a Mail Account's own credential. */
  mailCredentialKey: string;
  /** `env.MAIL_VAPID_PUBLIC_KEY` — `null` when the operator has never run `generate-vapid-keys`. */
  vapidPublicKey: string | null;
  /** `env.MAIL_VERSION` (`compose.yaml`'s `${MAIL_VERSION:-edge}`), or `"dev"` outside Docker. */
  imageTag: string;
}

/** Parses `:provider`, replying 400 for anything but `google`/`microsoft` — the two Providers a Registration exists for (CONTEXT.md). */
function parseProviderParam(
  request: { params: unknown },
  reply: FastifyReply,
): Provider | undefined {
  const result = providerSchema.safeParse((request.params as { provider?: string }).provider);
  if (!result.success) {
    reply.code(400).send({ error: "invalid_provider" });
    return undefined;
  }
  return result.data;
}

/**
 * The Owner-only Instance page's routes (#104, #115): the four running-
 * instance facts from #104, plus ADR-0021's Provider Health and Provider
 * Registration CRUD under the same `/instance` prefix (poc-scope.md: no new
 * top-level route prefix). Every one of these is gated on `requireOwner`
 * rather than `requireAuth` — CONTEXT.md's "the one thing a Member cannot
 * fix" applies to reading Provider Health exactly as it does to changing it.
 */
export async function instanceRoutes(
  app: FastifyInstance,
  { db, publicUrl, mailCredentialKey, vapidPublicKey, imageTag }: InstanceRoutesOptions,
) {
  const key = deriveCredentialKey(mailCredentialKey);

  async function buildProviderHealth(provider: Provider): Promise<ProviderHealth> {
    const [registration, mailAccountCount, needsReauthCount] = await Promise.all([
      getProviderRegistration(db, provider),
      countMailAccountsForProvider(db, provider),
      countNeedsReauthMailAccountsForProvider(db, provider),
    ]);
    return {
      provider,
      status: registration ? "registered_untested" : "not_registered",
      redirectUri: buildProviderRedirectUri(publicUrl, provider),
      clientIdPreview: registration?.clientId ?? null,
      mailAccountCount,
      needsReauthCount,
      // Working/Failing arrive with #118's refresh loop — until then there is
      // no refresh attempt to report on (ADR-0021).
      lastRefreshAt: null,
      lastRefreshError: null,
    };
  }

  app.get("/instance/health", { preHandler: app.requireOwner }, async () => {
    const providers = await Promise.all(PROVIDERS.map((provider) => buildProviderHealth(provider)));
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
      providers,
    });
  });

  // Save (#115): create-or-replace, no restart. Never echoes the secret back
  // — `buildProviderHealth` only ever reads `clientId` off the stored row.
  app.put(
    "/instance/providers/:provider",
    { preHandler: app.requireOwner },
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
    { preHandler: app.requireOwner },
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
