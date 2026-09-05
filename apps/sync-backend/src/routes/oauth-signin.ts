import { randomUUID } from "node:crypto";
import {
  OAUTH_SIGN_IN_OUTCOME_PARAM,
  type OAuthSignInOutcome,
  PROVIDERS,
  type Provider,
  type ProviderAvailability,
  providerAvailabilityListResponseSchema,
  providerSchema,
  startProviderSignInRequestSchema,
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
import { microsoftProviderAdapter } from "../mail-accounts/microsoft-adapter.js";
import type {
  ProviderAdapter,
  ProviderAdapters,
  ProviderGrant,
} from "../mail-accounts/provider-adapter.js";
import { consumeSignInAttempt, startSignInAttempt } from "../mail-accounts/sign-in-attempts.js";
import {
  getMailAccountForUser,
  getMailAccountForUserByAddress,
  insertMailAccount,
  replaceMailAccountCredential,
} from "../mail-accounts/store.js";
import { verifyMailAccountCredentials } from "../mail-accounts/verify.js";
import { getProviderRegistration } from "../provider-registrations/store.js";
import { noopSyncManager, type SyncManager } from "../sync/manager.js";
import { parseProviderParam } from "./route-params.js";

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
 * Everything Google- or Microsoft-shaped is behind `ProviderAdapter` — this
 * file names no endpoint, no scope and no token field, which is what lets
 * its tests drive the entire flow with a fake adapter. The one exception is
 * `tenant_refused` (#117): ADR-0021's admin-consent/blocked-IMAP outcome is
 * classified by the adapter (`isTenantRefusal`) but read out here through
 * the standard OAuth 2.0/OIDC `error` codes both an authorization redirect
 * and a token-exchange failure carry — a shape the spec defines, not either
 * Provider.
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
  /** The one new seam (#116). Defaults to the real Google and Microsoft adapters; tests pass a fake. */
  providerAdapters?: ProviderAdapters;
  /** Overridable in tests, same reason `routes/mail-accounts.ts` overrides it: no real IMAP/SMTP server in a unit test. */
  verify?: typeof verifyMailAccountCredentials;
  /** Starts the new account's resident sync loop (#35), so it is already syncing when the User lands back on the page. */
  syncManager?: SyncManager;
}

export const defaultProviderAdapters: ProviderAdapters = {
  google: googleProviderAdapter,
  microsoft: microsoftProviderAdapter,
};

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
  const requireAuthWithRateLimit = (groupId: string, max: number) => [
    app.requireAuth,
    app.rateLimit({
      groupId,
      max,
      timeWindow: 60_000,
      keyGenerator: (request) => request.user?.id ?? request.ip,
    }),
  ];
  const oauthCallbackRateLimit = app.rateLimit({
    groupId: "oauth-provider-callback",
    max: 10,
    timeWindow: 60_000,
    keyGenerator: (request) => request.user?.id ?? request.ip,
  });

  /** The redirect URI must be byte-identical between the authorization request, the token exchange and the Provider's console (#115's `buildProviderRedirectUri`) — one call site, no chance of drift. */
  const redirectUriFor = (provider: Provider) => buildProviderRedirectUri(publicUrl, provider);

  function finish(reply: FastifyReply, outcome: OAuthSignInOutcome) {
    const target = new URL(MAIL_ACCOUNTS_SETTINGS_PATH, publicUrl);
    target.searchParams.set(OAUTH_SIGN_IN_OUTCOME_PARAM, outcome);
    return reply.redirect(target.toString(), 302);
  }

  /** Seals a `ProviderGrant` the same way for a new Mail Account and a reauth'd one — one shape, one call site each. */
  function sealGrant(grant: ProviderGrant, provider: Provider, id: string) {
    return sealOAuthCredential(
      {
        provider,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt,
        scope: grant.scope,
      },
      id,
      key,
    );
  }

  /** Verify-before-save (poc-spec.md §Mail Accounts), over XOAUTH2, for both the add-account and reauth paths. */
  function verifyGrant(input: {
    imap: Parameters<typeof verify>[0]["imap"];
    smtp: Parameters<typeof verify>[0]["smtp"];
    username: string;
    grant: ProviderGrant;
  }) {
    return verify({
      imap: input.imap,
      smtp: input.smtp,
      username: input.username,
      credential: { kind: "oauth", accessToken: input.grant.accessToken },
    });
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

  // Naming a `mailAccountId` (#119) turns this into a `reauth` attempt: "sign
  // in again" on an OAuth account in Needs Reauth, or a password account's
  // settings row offering to switch to a Grant — the same door either way.
  // `login_hint` comes from the Mail Account's own stored address, never
  // from the Client, so a User can't be tricked into approving the wrong
  // identity by a tampered request.
  app.post(
    "/auth/oauth/:provider/start",
    { preHandler: requireAuthWithRateLimit("oauth-provider-start", 10) },
    async (request, reply) => {
      const provider = parseProviderParam(request, reply);
      if (!provider) return reply;

      const body = startProviderSignInRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
      }

      const adapter = providerAdapters[provider];
      if (!adapter) {
        return reply.code(409).send({ error: "provider_not_supported" });
      }
      const registration = await getProviderRegistration(db, provider);
      if (!registration) {
        return reply.code(409).send({ error: "provider_not_registered" });
      }

      const userId = requireUser(request).id;
      let loginHint: string | undefined;
      if (body.data.mailAccountId) {
        const account = await getMailAccountForUser(db, userId, body.data.mailAccountId);
        if (!account) {
          return reply.code(404).send({ error: "not_found" });
        }
        loginHint = account.emailAddress;
      }

      const attempt = await startSignInAttempt(db, {
        userId,
        provider,
        purpose: body.data.mailAccountId ? "reauth" : "add_mail_account",
        mailAccountId: body.data.mailAccountId,
      });

      return startProviderSignInResponseSchema.parse({
        authorizationUrl: adapter.authorizationUrl({
          clientId: registration.clientId,
          redirectUri: redirectUriFor(provider),
          state: attempt.state,
          codeChallenge: attempt.codeChallenge,
          loginHint,
        }),
      });
    },
  );

  app.get(
    "/auth/oauth/:provider/callback",
    { preHandler: oauthCallbackRateLimit },
    async (request, reply) => {
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

      const query = request.query as {
        code?: string;
        state?: string;
        error?: string;
        error_description?: string;
      };
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

      const adapter = providerAdapters[provider];

      // `access_denied` is the User pressing Cancel on the consent screen —
      // ADR-0021's "plain toast", not an error worth a different word for.
      // Anything else the adapter recognises as a tenant refusal (#117: an
      // M365 tenant blocking IMAP or withholding admin consent) is a distinct,
      // never-retry outcome; everything left over is an ordinary provider_error.
      if (query.error) {
        if (
          query.error !== "access_denied" &&
          adapter?.isTenantRefusal?.({ error: query.error, detail: query.error_description })
        ) {
          return finish(reply, "tenant_refused");
        }
        return finish(reply, query.error === "access_denied" ? "cancelled" : "provider_error");
      }
      if (typeof query.code !== "string" || query.code.length === 0) {
        return finish(reply, "provider_error");
      }

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
        const errorCode = errorCodeOf(err);
        if (
          errorCode &&
          adapter.isTenantRefusal?.({
            error: errorCode,
            detail: err instanceof Error ? err.message : undefined,
          })
        ) {
          request.log.warn({ err, provider }, "A tenant refused the sign-in (ADR-0021).");
          return finish(reply, "tenant_refused");
        }
        request.log.warn({ err, provider }, "Provider rejected the authorization code exchange.");
        return finish(reply, "provider_error");
      }

      // The address is the Provider's answer, never the User's (ADR-0021).
      const emailAddress = grant.emailAddress;

      if (attempt.purpose === "reauth") {
        return finishReauth(request, reply, {
          provider,
          mailAccountId: attempt.mailAccountId,
          userId: user.id,
          emailAddress,
          grant,
        });
      }

      if (await getMailAccountForUserByAddress(db, user.id, emailAddress)) {
        return finish(reply, "duplicate_address");
      }

      // Verify-before-save, the same rule a password account has always had
      // (poc-spec.md §Mail Accounts) — over XOAUTH2 here, through the very
      // `credential-auth.ts` seam #114 built for it.
      const { imap, smtp } = adapter.connection;
      const result = await verifyGrant({ imap, smtp, username: emailAddress, grant });
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
        credential: sealGrant(grant, provider, id),
      });
      // "back to the Mail Accounts settings page with the new Gmail account
      // already syncing" (#116): the same call `POST /mail-accounts` makes.
      syncManager.start(row);

      return finish(reply, "signed_in");
    },
  );

  /**
   * The `reauth` half of the callback (#119): "sign in with Google/Microsoft
   * again" on a Mail Account already in Needs Reauth, or a password Gmail
   * account switching to a Grant from its settings row. Both are "replace
   * this Mail Account's credential", never "create a new one" — the Mail
   * Account id, its Threads, Labels, pins and Gatekeeper state never move.
   */
  async function finishReauth(
    request: FastifyRequest,
    reply: FastifyReply,
    input: {
      provider: Provider;
      mailAccountId: string | null;
      userId: string;
      emailAddress: string;
      grant: ProviderGrant;
    },
  ) {
    // `startSignInAttempt` always sets `mailAccountId` for a `reauth`
    // attempt; a null here means the row was corrupted or hand-crafted, not
    // a real attempt this route ever started.
    const account = input.mailAccountId
      ? await getMailAccountForUser(db, input.userId, input.mailAccountId)
      : null;
    if (!account) {
      // The Mail Account was deleted while the User was at the consent
      // screen — nothing left to attach this Grant to.
      return finish(reply, "invalid_state");
    }

    // ADR-0021: "refused with a plain message ... changes nothing". Matched
    // case-sensitively on the stored address, the same identity the Provider
    // itself is authoritative for (never the User's typing).
    if (input.emailAddress !== account.emailAddress) {
      return finish(reply, "reauth_address_mismatch");
    }

    // Verify-before-save holds here too: a Grant that doesn't survive
    // IMAP/SMTP replaces nothing (poc-spec.md §Mail Accounts).
    const imap = { host: account.imapHost, port: account.imapPort, security: account.imapSecurity };
    const smtp = { host: account.smtpHost, port: account.smtpPort, security: account.smtpSecurity };
    const result = await verifyGrant({
      imap,
      smtp,
      username: input.emailAddress,
      grant: input.grant,
    });
    if (!result.ok) {
      request.log.warn(
        { provider: input.provider, reason: result.reason, detail: result.detail },
        "A reauth Grant did not survive IMAP/SMTP verification; the Mail Account's credential was not replaced.",
      );
      return finish(reply, "verification_failed");
    }

    await replaceMailAccountCredential(
      db,
      account.id,
      input.emailAddress,
      sealGrant(input.grant, input.provider, account.id),
    );
    // Resumes syncing (#35), the same hook the password reauth route uses —
    // a Needs-Reauth account's session has already stopped itself for good,
    // and an active account's session is reconnecting with a now-stale
    // credential either way.
    await syncManager.restart(account.id);

    return finish(reply, "reauth_succeeded");
  }
}

/**
 * Structurally duck-types a Provider's own token-error shape (Google's
 * `GoogleTokenError`, Microsoft's `MicrosoftTokenError`) without naming
 * either — both carry their machine-readable `.error` code the same way,
 * which is all `isTenantRefusal` (#117) needs to read off whatever
 * `exchangeCode` threw.
 */
function errorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "error" in err) {
    const value = (err as { error: unknown }).error;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function requireUser(request: FastifyRequest): { id: string } {
  if (!request.user) {
    throw new Error("requireAuth did not populate request.user");
  }
  return request.user;
}
