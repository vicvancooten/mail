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
