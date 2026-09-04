import type { MailAccountConnection } from "@mail/shared";
import type {
  AuthorizationUrlInput,
  ExchangeCodeInput,
  ProviderAdapter,
  ProviderGrant,
  ProviderRefreshResult,
  RefreshInput,
} from "./provider-adapter.js";

/**
 * Google's `ProviderAdapter` (#116, ADR-0021) — a thin HTTP wrapper over
 * three endpoints and nothing else. Every decision that isn't Google's own
 * (what to do with a duplicate address, when to verify, what to store) lives
 * in `routes/oauth-signin.ts`; everything here is "what Google's API happens
 * to look like".
 */

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Mail-only (ADR-0021): `https://mail.google.com/` is the IMAP/SMTP scope,
 * `openid email` is the identity the signed-in address comes from. Contacts
 * and Calendar ask later by incremental consent, never here.
 */
export const GOOGLE_SCOPES = ["https://mail.google.com/", "openid", "email"];

/** Gmail's fixed endpoints — a Mail Account added by signing in never runs autodiscover. */
const GMAIL_CONNECTION: { imap: MailAccountConnection; smtp: MailAccountConnection } = {
  imap: { host: "imap.gmail.com", port: 993, security: "tls" },
  smtp: { host: "smtp.gmail.com", port: 587, security: "starttls" },
};

/** Google reports a revoked or expired refresh token as exactly this, and everything else as something else. */
const WITHDRAWN_ERROR = "invalid_grant";

export const googleProviderAdapter: ProviderAdapter = {
  connection: GMAIL_CONNECTION,
  scopes: GOOGLE_SCOPES,

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
    url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // `offline` is what makes Google issue a refresh token at all — without
    // it the Grant would die with its first access token an hour later.
    url.searchParams.set("access_type", "offline");
    // ADR-0021's account chooser, plus `consent`: Google only re-issues a
    // refresh token when it re-prompts for consent, so a User who has
    // authorized this instance's app before would otherwise come back with
    // an access token and no refresh token — a Grant that dies in an hour.
    // Both values, space separated, is Google's documented way to ask for
    // both prompts.
    url.searchParams.set("prompt", "select_account consent");
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
    const payload = await postForm({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
    });

    const accessToken = requireString(payload, "access_token");
    const refreshToken = requireString(payload, "refresh_token");
    const idToken = requireString(payload, "id_token");
    return {
      accessToken,
      refreshToken,
      expiresAt: expiresAtFrom(payload),
      scope: scopeFrom(payload),
      emailAddress: emailFromIdToken(idToken),
    };
  },

  async refresh({ clientId, clientSecret, refreshToken }: RefreshInput) {
    let payload: Record<string, unknown>;
    try {
      payload = await postForm({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });
    } catch (err) {
      return classifyRefreshFailure(err);
    }
    return {
      ok: true,
      accessToken: requireString(payload, "access_token"),
      // Google does not rotate refresh tokens: a successful refresh answers
      // without one, and the original stays valid.
      refreshToken:
        typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken,
      expiresAt: expiresAtFrom(payload),
      scope: scopeFrom(payload),
    } satisfies ProviderRefreshResult;
  },
};

/**
 * A non-2xx from Google's token endpoint, carrying its own `error` code —
 * the only thing that separates a withdrawn Grant from a bad day on the
 * network (`ProviderRefreshResult`).
 */
export class GoogleTokenError extends Error {
  readonly error: string;

  constructor(error: string, detail: string) {
    super(detail);
    this.name = "GoogleTokenError";
    this.error = error;
  }
}

function classifyRefreshFailure(err: unknown): ProviderRefreshResult {
  if (err instanceof GoogleTokenError && err.error === WITHDRAWN_ERROR) {
    return { ok: false, reason: "withdrawn", detail: err.message };
  }
  return {
    ok: false,
    reason: "transient",
    detail: err instanceof Error ? err.message : String(err),
  };
}

async function postForm(fields: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    const description =
      typeof payload.error_description === "string"
        ? payload.error_description
        : text.slice(0, 200);
    throw new GoogleTokenError(error, `Google token endpoint: ${error} — ${description}`);
  }
  return payload;
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new GoogleTokenError("malformed_response", `Google's token response had no "${field}".`);
  }
  return value;
}

function expiresAtFrom(payload: Record<string, unknown>): string {
  const seconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function scopeFrom(payload: Record<string, unknown>): string[] {
  const scope = payload.scope;
  return typeof scope === "string" && scope.length > 0 ? scope.split(" ") : GOOGLE_SCOPES;
}

/**
 * The signed-in address, out of the `id_token` Google returns alongside the
 * access token. Its signature is deliberately not verified: this token came
 * back over TLS directly from Google's own token endpoint in response to a
 * request carrying the client secret, which is the exact case Google's
 * documentation calls out as not needing validation. (An id_token arriving
 * from anywhere else would — but none does here.) Decoding it saves a second
 * round trip to the userinfo endpoint for the one field this flow needs.
 */
function emailFromIdToken(idToken: string): string {
  const segment = idToken.split(".")[1];
  if (!segment) {
    throw new GoogleTokenError("malformed_response", "Google's id_token had no payload segment.");
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new GoogleTokenError("malformed_response", "Google's id_token payload was not JSON.");
  }
  const email = claims.email;
  if (typeof email !== "string" || email.length === 0) {
    throw new GoogleTokenError("malformed_response", "Google's id_token carried no email claim.");
  }
  return email;
}
