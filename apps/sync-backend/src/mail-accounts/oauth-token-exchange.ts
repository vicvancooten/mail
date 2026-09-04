import type { ProviderRefreshResult } from "./provider-adapter.js";

/**
 * What every OAuth token endpoint's failures converge on, structurally
 * (RFC 6749 §5.2): a non-2xx response carrying its own machine-readable
 * `error` code. It's this shared shape that `routes/oauth-signin.ts`'s own
 * `errorCodeOf` duck-types across Google and Microsoft alike without naming
 * either — this class is the one thing both adapters throw.
 */
export class OAuthTokenError extends Error {
  readonly error: string;

  constructor(providerName: string, error: string, detail: string) {
    super(detail);
    this.name = `${providerName}TokenError`;
    this.error = error;
  }
}

/**
 * What actually differs between a Provider's token-endpoint plumbing: the
 * endpoint itself, its name for error messages, and the scopes to fall back
 * to when a token response omits `scope` entirely.
 */
export interface TokenExchangeConfig {
  /** e.g. "Google", "Microsoft" — used only in error messages and `Error#name`. */
  providerName: string;
  tokenEndpoint: string;
  fallbackScopes: string[];
}

/** POSTs a `application/x-www-form-urlencoded` request at `config.tokenEndpoint` and returns its JSON body, throwing `OAuthTokenError` for anything but a 2xx. */
export async function postForm(
  config: TokenExchangeConfig,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(config.tokenEndpoint, {
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
    throw new OAuthTokenError(
      config.providerName,
      error,
      `${config.providerName} token endpoint: ${error} — ${description}`,
    );
  }
  return payload;
}

export function requireString(
  config: TokenExchangeConfig,
  payload: Record<string, unknown>,
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new OAuthTokenError(
      config.providerName,
      "malformed_response",
      `${config.providerName}'s token response had no "${field}".`,
    );
  }
  return value;
}

export function expiresAtFrom(payload: Record<string, unknown>): string {
  const seconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function scopeFrom(config: TokenExchangeConfig, payload: Record<string, unknown>): string[] {
  const scope = payload.scope;
  return typeof scope === "string" && scope.length > 0 ? scope.split(" ") : config.fallbackScopes;
}

/**
 * `withdrawn` and `transient` mean opposite things (ADR-0021): only the
 * Provider's own `error` code — `invalid_grant` for both Google and
 * Microsoft, RFC 6749 §5.2's standard code for the same fact — tells a
 * withdrawn Grant apart from a bad day on the network.
 */
export function classifyRefreshFailure(
  err: unknown,
  withdrawnError: string,
): ProviderRefreshResult {
  if (err instanceof OAuthTokenError && err.error === withdrawnError) {
    return { ok: false, reason: "withdrawn", detail: err.message };
  }
  return {
    ok: false,
    reason: "transient",
    detail: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Decodes an `id_token`'s payload segment without verifying its signature —
 * deliberately, per both adapters: it came back over TLS directly from the
 * Provider's own token endpoint in response to a request carrying the client
 * secret, which is the exact case each Provider's documentation calls out as
 * not needing validation.
 */
export function decodeIdTokenClaims(
  config: TokenExchangeConfig,
  idToken: string,
): Record<string, unknown> {
  const segment = idToken.split(".")[1];
  if (!segment) {
    throw new OAuthTokenError(
      config.providerName,
      "malformed_response",
      `${config.providerName}'s id_token had no payload segment.`,
    );
  }
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new OAuthTokenError(
      config.providerName,
      "malformed_response",
      `${config.providerName}'s id_token payload was not JSON.`,
    );
  }
}
