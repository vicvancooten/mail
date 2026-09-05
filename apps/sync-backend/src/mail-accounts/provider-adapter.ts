import type { MailAccountConnection, Provider } from "@mail/shared";

/**
 * The one new seam this ticket introduces (#116, ADR-0021): everything that
 * is *specific to one Provider* behind an interface, so the sign-in routes
 * (`routes/oauth-signin.ts`) contain no Google-shaped code at all and a test
 * can drive the whole flow with a fake instead of a live OAuth endpoint.
 * Injected into `buildApp` exactly the way `mailAccountVerify` and
 * `mailAccountDiscover` already are.
 *
 * Deliberately three required methods and no more. `authorizationUrl` is
 * where the browser is sent, `exchangeCode` is the whole of "what came
 * back", `refresh` is #118's only entry point. The real Google
 * implementation (`google-adapter.ts`) is a thin HTTP wrapper over these
 * three. `isTenantRefusal` (#117) is the one optional fourth: a Provider
 * with nothing tenant-shaped about its errors need not implement it.
 */

export interface AuthorizationUrlInput {
  clientId: string;
  /** Derived from `PUBLIC_URL` by `instance-info.ts#buildProviderRedirectUri` — the exact string the Owner pasted into the Provider's console. */
  redirectUri: string;
  /** CSRF and correlation, opaque to the adapter. */
  state: string;
  /** PKCE's S256 challenge; the adapter never sees the verifier until `exchangeCode`. */
  codeChallenge: string;
  /** The address to pre-select, for a reauth of a known Mail Account. Omitted on a fresh add, which always shows the account chooser. */
  loginHint?: string;
}

export interface ExchangeCodeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

/**
 * A Grant as the Provider just handed it over, plus the one fact the flow
 * refuses to take from the User: `emailAddress` is the Provider's own
 * identity answer (ADR-0021, "the Mail Account address comes from the
 * Provider's identity response, never typed").
 */
export interface ProviderGrant {
  accessToken: string;
  refreshToken: string;
  /** ISO 8601, absolute — the caller never has to know when the exchange happened. */
  expiresAt: string;
  scope: string[];
  emailAddress: string;
}

export interface RefreshInput {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * A typed answer rather than a thrown error, because the two failures mean
 * opposite things (ADR-0021): `withdrawn` is the second door into Needs
 * Reauth — the User revoked access, or the app fell back to Testing status
 * and the refresh token aged out — while `transient` is a network blip the
 * refresh loop retries. Nothing but the Provider itself can tell them apart,
 * so the adapter is where the distinction is made.
 */
export type ProviderRefreshResult =
  | {
      ok: true;
      accessToken: string;
      /** Providers that don't rotate the refresh token echo the one they were given. */
      refreshToken: string;
      expiresAt: string;
      scope: string[];
    }
  | { ok: false; reason: "withdrawn" | "transient"; detail: string };

/**
 * An authorization-stage failure to classify: either the `error` query
 * parameter a Provider's `/authorize` redirect can carry back (RFC 6749
 * §4.1.2.1's `error`, plus OIDC's `interaction_required`/`consent_required`
 * extensions), or the `.error` code an adapter's own token-error type
 * exposes when `exchangeCode` throws (Google's `GoogleTokenError`,
 * Microsoft's `MicrosoftTokenError` — both converge on this same shape
 * without either naming the other).
 */
export interface AuthorizationCallbackError {
  error: string;
  detail?: string;
}

export interface ProviderAdapter {
  /**
   * The Provider's IMAP and SMTP endpoints. Fixed per Provider — a Mail
   * Account added by signing in never runs autodiscover and never asks the
   * User for a host, so this is where those hosts live.
   */
  readonly connection: { imap: MailAccountConnection; smtp: MailAccountConnection };
  /** Mail-only, per ADR-0021 — quoted back in the authorization URL and stored on the Grant. */
  readonly scopes: string[];
  authorizationUrl(input: AuthorizationUrlInput): string;
  exchangeCode(input: ExchangeCodeInput): Promise<ProviderGrant>;
  refresh(input: RefreshInput): Promise<ProviderRefreshResult>;
  /**
   * Distinguishes ADR-0021's "an M365 tenant that blocks IMAP or requires
   * admin consent" from an ordinary Provider error, so `routes/oauth-signin.ts`
   * can answer with `tenant_refused` instead of `provider_error` — a failure
   * the User cannot fix by retrying. Optional: nothing about Google's own
   * errors is tenant-shaped, so it declines to implement this and every
   * failure of its stays `provider_error` (#117).
   */
  isTenantRefusal?(failure: AuthorizationCallbackError): boolean;
}

/**
 * Partial on purpose: a Provider with no entry renders as a choice that is
 * unavailable for a reason no Owner can fix by registering anything
 * (`not_supported`, `@mail/shared`'s `ProviderUnavailableReason`) — a build
 * that ships neither adapter, or a future Provider added to `PROVIDERS`
 * before its adapter lands, is exactly that. ADR-0021's "shown as
 * unavailable ... never hidden" applies to a missing adapter as much as to a
 * missing Registration.
 */
export type ProviderAdapters = Partial<Record<Provider, ProviderAdapter>>;
