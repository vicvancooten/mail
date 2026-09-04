import type { MailAccountConnection } from "@mail/shared";
import {
  classifyRefreshFailure,
  decodeIdTokenClaims,
  expiresAtFrom,
  OAuthTokenError,
  postForm,
  requireString,
  scopeFrom,
  type TokenExchangeConfig,
} from "./oauth-token-exchange.js";
import type {
  AuthorizationCallbackError,
  AuthorizationUrlInput,
  ExchangeCodeInput,
  ProviderAdapter,
  ProviderGrant,
  ProviderRefreshResult,
  RefreshInput,
} from "./provider-adapter.js";

/**
 * Microsoft's `ProviderAdapter` (#117, ADR-0021) — a thin HTTP wrapper over
 * the `common` multi-tenant v2.0 endpoint and nothing else, mirroring
 * `google-adapter.ts`'s own shape. Every decision that isn't Microsoft's own
 * (what to do with a duplicate address, when to verify, what to store) lives
 * in `routes/oauth-signin.ts`; everything here is "what Microsoft's API
 * happens to look like". The plumbing common to every Provider's token
 * endpoint lives in `oauth-token-exchange.ts`; this file is only what's
 * Microsoft's own.
 */

/**
 * The `common` authority (not `organizations`, not `consumers`): ADR-0021's
 * "targets personal *and* work/school accounts" through one Registration —
 * the Entra app registration's own "Accounts in any organizational directory
 * and personal Microsoft accounts" account type (docs/installation.md
 * §Microsoft).
 */
const AUTHORIZATION_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/**
 * Mail-only (ADR-0021): the resource-qualified IMAP and SMTP scope strings
 * Microsoft's own docs specify (Exchange Online's "Authenticate an IMAP,
 * POP or SMTP connection using OAuth"), `offline_access` for a refresh
 * token, `openid email` for the identity the signed-in address comes from.
 */
export const MICROSOFT_SCOPES = [
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
  "offline_access",
  "openid",
  "email",
];

/** Outlook's fixed endpoints — the same host serves Outlook.com and Microsoft 365 alike, and a Mail Account added by signing in never runs autodiscover. */
const OUTLOOK_CONNECTION: { imap: MailAccountConnection; smtp: MailAccountConnection } = {
  imap: { host: "outlook.office365.com", port: 993, security: "tls" },
  smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
};

/**
 * Microsoft reports a revoked or expired refresh token as `invalid_grant`,
 * the same standard OAuth 2.0 code (RFC 6749 §5.2) Google uses for the same
 * fact — nothing Microsoft-specific about the code itself, just its meaning
 * here.
 */
const WITHDRAWN_ERROR = "invalid_grant";

/**
 * The standard authorization/token-endpoint error codes
 * (learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow's
 * own error tables) that mean ADR-0021's tenant refusal — an admin never
 * consented, or a Conditional Access / tenant policy blocked the client —
 * rather than the User declining (`access_denied`) or an ordinary hiccup.
 */
const TENANT_REFUSAL_ERRORS = new Set([
  // "The client application isn't permitted ... usually occurs when the
  // client application isn't registered in Microsoft Entra ID or isn't
  // added to the user's Microsoft Entra tenant."
  "unauthorized_client",
  // "The request requires user consent" — an admin has not (yet) approved
  // this Registration's permissions for the tenant.
  "consent_required",
  // "Another authentication step or consent is required" — surfaces on the
  // token endpoint too, non-standard per Microsoft's own docs, for the same
  // underlying reason.
  "interaction_required",
]);

const TOKEN_EXCHANGE: TokenExchangeConfig = {
  providerName: "Microsoft",
  tokenEndpoint: TOKEN_ENDPOINT,
  fallbackScopes: MICROSOFT_SCOPES,
};

export const microsoftProviderAdapter: ProviderAdapter = {
  connection: OUTLOOK_CONNECTION,
  scopes: MICROSOFT_SCOPES,

  authorizationUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge,
    loginHint,
  }: AuthorizationUrlInput): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", MICROSOFT_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // ADR-0021's account chooser. Unlike Google, Microsoft reissues a
    // refresh token on every successful code exchange that asked for
    // `offline_access` regardless of prior consent, so there is no
    // Google-style `consent` prompt to add here.
    url.searchParams.set("prompt", "select_account");
    if (loginHint) {
      url.searchParams.set("login_hint", loginHint);
    }
    return url.toString();
  },

  async exchangeCode({
    clientId,
    clientSecret,
    redirectUri,
    code,
    codeVerifier,
  }: ExchangeCodeInput): Promise<ProviderGrant> {
    const payload = await postForm(TOKEN_EXCHANGE, {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPES.join(" "),
    });

    const accessToken = requireString(TOKEN_EXCHANGE, payload, "access_token");
    const refreshToken = requireString(TOKEN_EXCHANGE, payload, "refresh_token");
    const idToken = requireString(TOKEN_EXCHANGE, payload, "id_token");
    return {
      accessToken,
      refreshToken,
      expiresAt: expiresAtFrom(payload),
      scope: scopeFrom(TOKEN_EXCHANGE, payload),
      emailAddress: emailFromIdToken(idToken),
    };
  },

  async refresh({ clientId, clientSecret, refreshToken }: RefreshInput) {
    let payload: Record<string, unknown>;
    try {
      payload = await postForm(TOKEN_EXCHANGE, {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        scope: MICROSOFT_SCOPES.join(" "),
      });
    } catch (err) {
      return classifyRefreshFailure(err, WITHDRAWN_ERROR);
    }
    return {
      ok: true,
      accessToken: requireString(TOKEN_EXCHANGE, payload, "access_token"),
      // Microsoft rotates refresh tokens on most successful refreshes but
      // doesn't guarantee it (learn.microsoft.com's own "discard the old
      // refresh token" note) — echo the original back when none comes.
      refreshToken:
        typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken,
      expiresAt: expiresAtFrom(payload),
      scope: scopeFrom(TOKEN_EXCHANGE, payload),
    } satisfies ProviderRefreshResult;
  },

  isTenantRefusal({ error }: AuthorizationCallbackError): boolean {
    return TENANT_REFUSAL_ERRORS.has(error);
  },
};

/**
 * The signed-in address, out of the `id_token` Microsoft returns alongside
 * the access token. Its signature is deliberately not verified — see
 * `decodeIdTokenClaims`. Prefers the `email` claim (present when the `email`
 * scope was requested and granted, learn.microsoft.com's ID token claims
 * reference), and falls back to `preferred_username` — which for a
 * work/school or Outlook.com account is its sign-in address — since
 * Microsoft's own docs warn `email` "isn't guaranteed" to be present even
 * when requested.
 */
function emailFromIdToken(idToken: string): string {
  const claims = decodeIdTokenClaims(TOKEN_EXCHANGE, idToken);
  const email = typeof claims.email === "string" && claims.email.length > 0 ? claims.email : null;
  const preferredUsername =
    typeof claims.preferred_username === "string" && claims.preferred_username.length > 0
      ? claims.preferred_username
      : null;
  const address = email ?? preferredUsername;
  if (!address) {
    throw new OAuthTokenError(
      TOKEN_EXCHANGE.providerName,
      "malformed_response",
      "Microsoft's id_token carried neither an email nor a preferred_username claim.",
    );
  }
  return address;
}
