import { randomUUID } from "node:crypto";
import {
  OAUTH_SIGN_IN_OUTCOME_PARAM,
  type OAuthSignInOutcome,
  PROVIDERS,
  type Provider,
  type ProviderAvailability,
  providerAvailabilityListResponseSchema,
  providerSchema,
  startProviderSignInResponseSchema,
} from "@mail/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { buildProviderRedirectUri } from "../instance-info.js";
import {
  deriveCredentialKey,
  sealOAuthCredential,
  unsealSecret,
} from "../mail-accounts/credential-crypto.js";
import { googleProviderAdapter } from "../mail-accounts/google-adapter.js";
import type { ProviderAdapter, ProviderAdapters } from "../mail-accounts/provider-adapter.js";
import { consumeSignInAttempt, startSignInAttempt } from "../mail-accounts/sign-in-attempts.js";
import { getMailAccountForUserByAddress, insertMailAccount } from "../mail-accounts/store.js";
import { verifyMailAccountCredentials } from "../mail-accounts/verify.js";
import { getProviderRegistration } from "../provider-registrations/store.js";
import { noopSyncManager, type SyncManager } from "../sync/manager.js";

/**
 * Sign in with a Provider to add a Mail Account (#116, ADR-0021). Two halves
 * that never meet in the same request:
 *
 * - `POST /auth/oauth/:provider/start` is an ordinary authenticated fetch.
 *   It mints the PKCE pair and the `state`, records the attempt, and answers
 *   with the Provider's authorization URL for the Client to navigate to.
 * - `GET /auth/oauth/:provider/callback` is a *browser navigation* the
 *   Provider sends back, not a fetch — no JSON body reaches the Client from
 *   here. It resolves the User from the session cookie (SameSite Lax
 *   survives a top-level cross-site redirect, which is why this works at
 *   all), does the whole exchange-verify-save, and redirects to the Mail
 *   Accounts settings page with an outcome code in the query string that the
 *   Client turns into a toast.
 *
 * Everything Google-shaped is behind `ProviderAdapter` — this file names no
 * endpoint, no scope and no token field, which is what lets its tests drive
 * the entire flow with a fake adapter.
 *
 * Both live under `/auth` on purpose: `isApiPath()` (`@mail/shared`) and the
 * Client's Vite dev proxy already cover that prefix, and #115's
 * `buildProviderRedirectUri` already told the Owner to register exactly
 * `{PUBLIC_URL}/auth/oauth/{provider}/callback` in the Provider's console.
 */

/** Where the callback always lands the browser — outcome or not, success or not. */
const MAIL_ACCOUNTS_SETTINGS_PATH = "/settings/mail-accounts";

export interface OAuthSignInRoutesOptions {
  db: Db;
  /** ADR-0009's single source of truth: the redirect URI's base, and the origin the callback redirects back into. */
  publicUrl: string;
  /** `env.MAIL_CREDENTIAL_KEY` (ADR-0003) — unseals the Registration's client secret, seals the Grant. */
  mailCredentialKey: string;
  /** The one new seam (#116). Defaults to the real Google adapter; tests pass a fake. Microsoft has no entry until #117. */
  providerAdapters?: ProviderAdapters;
  /** Overridable in tests, same reason `routes/mail-accounts.ts` overrides it: no real IMAP/SMTP server in a unit test. */
  verify?: typeof verifyMailAccountCredentials;
  /** Starts the new account's resident sync loop (#35), so it is already syncing when the User lands back on the page. */
  syncManager?: SyncManager;
}

export const defaultProviderAdapters: ProviderAdapters = { google: googleProviderAdapter };

export async function oauthSignInRoutes(
  app: FastifyInstance,
  {
    db,
    publicUrl,
    mailCredentialKey,
    providerAdapters = defaultProviderAdapters,
    verify = verifyMailAccountCredentials,
    syncManager = noopSyncManager,
  }: OAuthSignInRoutesOptions,
) {
  const key = deriveCredentialKey(mailCredentialKey);

  /** The redirect URI must be byte-identical between the authorization request, the token exchange and the Provider's console (#115's `buildProviderRedirectUri`) — one call site, no chance of drift. */
  const redirectUriFor = (provider: Provider) => buildProviderRedirectUri(publicUrl, provider);

  function finish(reply: FastifyReply, outcome: OAuthSignInOutcome) {
    const target = new URL(MAIL_ACCOUNTS_SETTINGS_PATH, publicUrl);
    target.searchParams.set(OAUTH_SIGN_IN_OUTCOME_PARAM, outcome);
    return reply.redirect(target.toString(), 302);
  }

  /**
   * Whether signing in with a Provider is possible right now, and if not,
   * why (ADR-0021: shown as unavailable, never hidden). Deliberately
   * readable by every User rather than Owner-only like Provider Health: a
   * Member has to see the choice to be told to ask the Owner, and this
   * carries no client ID, no secret, and no account counts.
   */
  app.get("/auth/oauth/providers", { preHandler: app.requireAuth }, async () => {
    const providers: ProviderAvailability[] = await Promise.all(
      PROVIDERS.map(async (provider) => {
        if (!providerAdapters[provider]) {
          return { provider, available: false, unavailableReason: "not_supported" as const };
        }
        const registration = await getProviderRegistration(db, provider);
        return registration
          ? { provider, available: true, unavailableReason: null }
          : { provider, available: false, unavailableReason: "not_registered" as const };
      }),
    );
    return providerAvailabilityListResponseSchema.parse({ providers });
  });

  app.post(
    "/auth/oauth/:provider/start",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const provider = parseProviderParam(request, reply);
      if (!provider) return reply;

      const adapter = providerAdapters[provider];
      if (!adapter) {
        return reply.code(409).send({ error: "provider_not_supported" });
      }
      const registration = await getProviderRegistration(db, provider);
      if (!registration) {
        return reply.code(409).send({ error: "provider_not_registered" });
      }

      const attempt = await startSignInAttempt(db, {
        userId: requireUser(request).id,
        provider,
        purpose: "add_mail_account",
      });

      return startProviderSignInResponseSchema.parse({
        authorizationUrl: adapter.authorizationUrl({
          clientId: registration.clientId,
          redirectUri: redirectUriFor(provider),
          state: attempt.state,
          codeChallenge: attempt.codeChallenge,
        }),
      });
    },
  );

  app.get("/auth/oauth/:provider/callback", async (request, reply) => {
    const parsed = providerSchema.safeParse((request.params as { provider?: string }).provider);
    if (!parsed.success) {
      return finish(reply, "invalid_state");
    }
    const provider = parsed.data;

    // The session cookie is the only thing that says whose Mail Account this
    // is; the `state` alone must never be enough (it travels through the
    // Provider and the URL bar). No session means nothing to attach to.
    const user = request.user;
    if (!user) {
      return finish(reply, "session_expired");
    }

    const query = request.query as { code?: string; state?: string; error?: string };
    if (typeof query.state !== "string") {
      return finish(reply, "invalid_state");
    }

    // Redeemed — and deleted — before anything else is decided, so even a
    // Provider-side error can't leave a live attempt behind to replay.
    const attempt = await consumeSignInAttempt(db, {
      state: query.state,
      userId: user.id,
      provider,
    });
    if (!attempt) {
      return finish(reply, "invalid_state");
    }

    // `access_denied` is the User pressing Cancel on the consent screen —
    // ADR-0021's "plain toast", not an error worth a different word for.
    if (query.error) {
      return finish(reply, query.error === "access_denied" ? "cancelled" : "provider_error");
    }
    if (typeof query.code !== "string" || query.code.length === 0) {
      return finish(reply, "provider_error");
    }

    const adapter = providerAdapters[provider];
    const registration = await getProviderRegistration(db, provider);
    if (!adapter || !registration) {
      // The Owner removed the Registration while the User was at the consent
      // screen. Nothing was created, and the reason is the Owner's to fix.
      return finish(reply, "provider_not_registered");
    }

    let grant: Awaited<ReturnType<ProviderAdapter["exchangeCode"]>>;
    try {
      grant = await adapter.exchangeCode({
        clientId: registration.clientId,
        clientSecret: unsealSecret(registration.clientSecret, provider, key),
        redirectUri: redirectUriFor(provider),
        code: query.code,
        codeVerifier: attempt.codeVerifier,
      });
    } catch (err) {
      request.log.warn({ err, provider }, "Provider rejected the authorization code exchange.");
      return finish(reply, "provider_error");
    }

    // The address is the Provider's answer, never the User's (ADR-0021).
    const emailAddress = grant.emailAddress;
    if (await getMailAccountForUserByAddress(db, user.id, emailAddress)) {
      return finish(reply, "duplicate_address");
    }

    // Verify-before-save, the same rule a password account has always had
    // (poc-spec.md §Mail Accounts) — over XOAUTH2 here, through the very
    // `credential-auth.ts` seam #114 built for it.
    const { imap, smtp } = adapter.connection;
    const result = await verify({
      imap,
      smtp,
      username: emailAddress,
      credential: { kind: "oauth", accessToken: grant.accessToken },
    });
    if (!result.ok) {
      request.log.warn(
        { provider, reason: result.reason, detail: result.detail },
        "A Provider Grant did not survive IMAP/SMTP verification; no Mail Account was created.",
      );
      return finish(reply, "verification_failed");
    }

    const id = randomUUID();
    const row = await insertMailAccount(db, {
      id,
      userId: user.id,
      emailAddress,
      imap,
      smtp,
      // Gmail's IMAP/SMTP login *is* the address, and there is no second
      // login to ask for — signing in is the only way this row is created.
      username: emailAddress,
      credential: sealOAuthCredential(
        {
          provider,
          accessToken: grant.accessToken,
          refreshToken: grant.refreshToken,
          expiresAt: grant.expiresAt,
          scope: grant.scope,
        },
        id,
        key,
      ),
    });
    // "back to the Mail Accounts settings page with the new Gmail account
    // already syncing" (#116): the same call `POST /mail-accounts` makes.
    syncManager.start(row);

    return finish(reply, "signed_in");
  });
}

/** Parses `:provider`, replying 400 for anything but `google`/`microsoft` — mirrors `routes/instance.ts`'s own. */
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

function requireUser(request: FastifyRequest): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
