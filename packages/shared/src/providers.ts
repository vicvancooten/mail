import { z } from "zod";

/**
 * The two Providers a Provider Registration exists for (CONTEXT.md, ADR-0021)
 * — Other IMAP needs no Registration at all, so it never appears here. Also
 * the display order the Instance page's Providers section lists them in.
 */
export const PROVIDERS = ["google", "microsoft"] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;

/**
 * `PUT /instance/providers/:provider` (#115, ADR-0021): the Owner pastes
 * these once, without a restart. `clientSecret` is write-only from here on —
 * it never comes back in any response (ADR-0003's same rule for a Mail
 * Account's own credential).
 */
export const saveProviderRegistrationRequestSchema = z.object({
  clientId: z.string().trim().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client secret is required"),
});
export type SaveProviderRegistrationRequest = z.infer<typeof saveProviderRegistrationRequestSchema>;

/**
 * Whether a Registration exists and, once #118 lands the refresh loop,
 * whether Grants through it are currently honoured. `registered_untested`
 * is honest about the gap ADR-0021 names: neither Provider can be validated
 * without a User consenting, so this stays true until the first Grant lands.
 */
export const providerStatusSchema = z.enum(["not_registered", "registered_untested"]);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

/**
 * One Provider's entry in `GET /instance/health`'s `providers` section
 * (#115, CONTEXT.md's Provider Health) — the same shape `PUT
 * /instance/providers/:provider` hands back for the one Provider it just
 * saved. `lastRefreshAt`/`lastRefreshError` are always null until #118 wires
 * up the refresh loop that reports on them.
 */
export const providerHealthSchema = z.object({
  provider: providerSchema,
  status: providerStatusSchema,
  /** Derived from `PUBLIC_URL`, exact — what to paste into the Provider's own console (ADR-0021). */
  redirectUri: z.string(),
  /** The registered client ID, verbatim — never the secret. Null before a Registration exists. */
  clientIdPreview: z.string().nullable(),
  mailAccountCount: z.int().nonnegative(),
  needsReauthCount: z.int().nonnegative(),
  lastRefreshAt: z.iso.datetime().nullable(),
  lastRefreshError: z.string().nullable(),
});
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

export const providerRegistrationResponseSchema = z.object({
  provider: providerHealthSchema,
});
export type ProviderRegistrationResponse = z.infer<typeof providerRegistrationResponseSchema>;

/**
 * `GET /instance/providers/:provider/delete-preview` and the `DELETE` that
 * follows it share this shape: "how many Mail Accounts will stop syncing"
 * before the Owner confirms, and "how many just did" in the same words
 * after (ADR-0021's "first tells the Owner how many Mail Accounts will stop
 * syncing").
 */
export const providerMailAccountCountResponseSchema = z.object({
  mailAccountCount: z.int().nonnegative(),
});
export type ProviderMailAccountCountResponse = z.infer<
  typeof providerMailAccountCountResponseSchema
>;

/**
 * What a User adding a Mail Account may actually do with a Provider (#116,
 * ADR-0021's "Members cannot fix a missing Registration, so an unregistered
 * Provider is shown as unavailable ... never hidden"). The choice is always
 * rendered; `unavailableReason` is why it can't be taken:
 *
 * - `not_registered` — no Provider Registration on this instance yet. A
 *   Member is told to ask the Owner; the Owner gets a link to Provider Health.
 * - `not_supported` — this build has no adapter for the Provider yet.
 *   Microsoft's is the next slice (#117), so its choice renders unavailable
 *   for a reason no Owner can fix by registering anything.
 */
export const providerUnavailableReasonSchema = z.enum(["not_registered", "not_supported"]);
export type ProviderUnavailableReason = z.infer<typeof providerUnavailableReasonSchema>;

export const providerAvailabilitySchema = z.object({
  provider: providerSchema,
  available: z.boolean(),
  /** Null exactly when `available` is true. */
  unavailableReason: providerUnavailableReasonSchema.nullable(),
});
export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;

/** `GET /auth/oauth/providers` (#116): one entry per Provider, in `PROVIDERS` order. Readable by any User — unlike Provider Health, it carries no Registration detail, only whether signing in is possible. */
export const providerAvailabilityListResponseSchema = z.object({
  providers: z.array(providerAvailabilitySchema),
});
export type ProviderAvailabilityListResponse = z.infer<
  typeof providerAvailabilityListResponseSchema
>;

/**
 * `POST /auth/oauth/:provider/start` (#116, #119). Omitting `mailAccountId`
 * starts an `add_mail_account` attempt with the account chooser shown;
 * naming one starts a `reauth` attempt instead — the same door for "sign in
 * again" on an OAuth account and "switch this password account to a Grant"
 * — and the start route sets `login_hint` to that Mail Account's own address
 * itself, never taking it from the Client.
 */
export const startProviderSignInRequestSchema = z.object({
  mailAccountId: z.string().min(1).optional(),
});
export type StartProviderSignInRequest = z.infer<typeof startProviderSignInRequestSchema>;

/** `POST /auth/oauth/:provider/start` (#116): the Provider's own authorization URL for the Client to send the browser to as a full-page redirect. */
export const startProviderSignInResponseSchema = z.object({
  authorizationUrl: z.url(),
});
export type StartProviderSignInResponse = z.infer<typeof startProviderSignInResponseSchema>;

/**
 * How a Provider sign-in ended (#116). The callback can't answer with JSON —
 * it is a browser navigation, not a fetch — so it redirects back to the Mail
 * Accounts settings page carrying one of these in the query string, and the
 * Client turns it into a toast and clears it. Every failure means nothing was
 * created.
 */
export const OAUTH_SIGN_IN_OUTCOME_PARAM = "oauth";

export const oauthSignInOutcomeSchema = z.enum([
  /** A Mail Account now exists on the signed-in address and is syncing. */
  "signed_in",
  /** The User declined at the Provider's own consent screen, or pressed back. */
  "cancelled",
  /** The session cookie was gone by the time the Provider redirected back — nothing to attach the account to. */
  "session_expired",
  /** No matching sign-in attempt: a replayed, tampered-with, or expired `state`. */
  "invalid_state",
  /** The signed-in address is already one of this User's Mail Accounts. */
  "duplicate_address",
  /** IMAP or SMTP refused the Grant — verify-before-save, so no row was written. */
  "verification_failed",
  /** The Provider itself failed the token exchange or the identity lookup. */
  "provider_error",
  /** The Registration was removed between starting the sign-in and coming back. */
  "provider_not_registered",
  /**
   * A `reauth` attempt's Grant, replacing the Mail Account's credential —
   * "sign in again" or a password account switching to a Grant (#119). Kept
   * distinct from `signed_in` because nothing was *created*.
   */
  "reauth_succeeded",
  /**
   * A `reauth` attempt whose Provider identity didn't match the Mail
   * Account's own address (#119, ADR-0021: "refused with a plain message ...
   * changes nothing"). Distinct from `duplicate_address`, which is the
   * opposite problem on an `add_mail_account` attempt.
   */
  "reauth_address_mismatch",
]);
export type OAuthSignInOutcome = z.infer<typeof oauthSignInOutcomeSchema>;
