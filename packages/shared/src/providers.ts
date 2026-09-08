import { z } from "zod";

/**
 * The glossary's **Provider** (CONTEXT.md, ADR-0022): one of four identity
 * kinds a Connected Account can hold. Only Google and Microsoft ever need a
 * Provider Registration (below) — Other IMAP and CalDAV/CardDAV never do,
 * since a password or app password needs nothing an Owner registers.
 */
export const PROVIDERS = ["google", "microsoft", "other_imap", "caldav_carddav"] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;

/**
 * The two Providers a Provider Registration exists for (CONTEXT.md, ADR-0021)
 * — the subset of `Provider` above that needs one. Also the display order
 * the Instance page's Providers section lists them in.
 */
export const REGISTERED_PROVIDERS = ["google", "microsoft"] as const;
export const registeredProviderSchema = z.enum(REGISTERED_PROVIDERS);
export type RegisteredProvider = z.infer<typeof registeredProviderSchema>;

/**
 * `PUT /instance/providers/:provider` (#115, ADR-0021): the Owner pastes
 * these once, without a restart. `clientSecret` is write-only from here on —
 * it never comes back in any response (ADR-0003's same rule for a Mail
 * Account's own credential).
 */
/**
 * The two Facets a User can ever *turn on* by consent (#202, ADR-0022):
 * `mail` is never one of these — a Mail Facet is created by signing in or
 * entering credentials in the first place (`AddMailAccountForm`), never
 * added onto an existing Connected Account. `POST /auth/oauth/:provider/start`'s
 * `facet` field is validated against this narrower schema, not
 * `connected-accounts.ts#connectedAccountFacetKindSchema`, so a request
 * naming `mail` is rejected at the boundary rather than reaching a route
 * that has no idea what to do with it.
 */
export const grantableFacetKindSchema = z.enum(["calendar", "contacts"]);
export type GrantableFacetKind = z.infer<typeof grantableFacetKindSchema>;

export const saveProviderRegistrationRequestSchema = z.object({
  clientId: z.string().trim().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client secret is required"),
  /**
   * Owner-declared, unvalidated the same way every other Registration fact
   * is (ADR-0021) — whether Google's Calendar API/People API, or Microsoft
   * Graph's calendar/contacts permissions, have been enabled on the Owner's
   * own project/app registration (ADR-0022: "Owner-only failures never show
   * as Needs Reauth ... a 403 for a missing API is a Registration problem").
   * Neither this instance nor any Grant can detect that fact from here, so
   * the Owner states it directly, the same way they confirm the consent
   * screen is In Production. Defaults to `false` — a fresh Registration
   * offers Mail only until the Owner says otherwise.
   */
  calendarApiEnabled: z.boolean().default(false),
  contactsApiEnabled: z.boolean().default(false),
});
export type SaveProviderRegistrationRequest = z.infer<typeof saveProviderRegistrationRequestSchema>;

/**
 * Whether a Registration exists and, since #118's refresh loop, whether
 * Grants through it are currently honoured. `registered_untested` is honest
 * about the gap ADR-0021 names: neither Provider can be validated without a
 * User consenting, so this stays true until the first Grant refresh — success
 * or failure — reports in. `working`/`failing` are derived from that last
 * refresh, never from a probe (ADR-0021): `working` once one has ever
 * succeeded, `failing` from the moment one comes back with an error, until
 * the next refresh clears it.
 */
export const providerStatusSchema = z.enum([
  "not_registered",
  "registered_untested",
  "working",
  "failing",
]);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

/**
 * One Provider's entry in `GET /instance/health`'s `providers` section
 * (#115, #118, CONTEXT.md's Provider Health) — the same shape `PUT
 * /instance/providers/:provider` hands back for the one Provider it just
 * saved. `lastRefreshAt` is the last refresh attempt's time regardless of
 * outcome (`routes/instance.ts` derives `working`/`failing` from whether
 * `lastRefreshError` is set alongside it); both stay null until the first
 * attempt.
 */
export const providerHealthSchema = z.object({
  provider: registeredProviderSchema,
  status: providerStatusSchema,
  /** Derived from `PUBLIC_URL`, exact — what to paste into the Provider's own console (ADR-0021). */
  redirectUri: z.string(),
  /** The registered client ID, verbatim — never the secret. Null before a Registration exists. */
  clientIdPreview: z.string().nullable(),
  mailAccountCount: z.int().nonnegative(),
  needsReauthCount: z.int().nonnegative(),
  lastRefreshAt: z.iso.datetime().nullable(),
  lastRefreshError: z.string().nullable(),
  /** ADR-0022's per-Facet Provider Health reading: the Owner's own declaration, `false` before a Registration exists. */
  calendarApiEnabled: z.boolean(),
  contactsApiEnabled: z.boolean(),
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

export const providerAvailabilitySchema = z.discriminatedUnion("available", [
  z.object({
    provider: registeredProviderSchema,
    available: z.literal(true),
    /** Null exactly when `available` is true. */
    unavailableReason: z.null(),
    /**
     * The Owner's per-Facet declaration (#202, ADR-0022), readable here by
     * any User — not just the Owner-only `ProviderHealth` — because a
     * Member has to see a Facet as unavailable ("ask the Owner") the same
     * way they already see an unregistered Provider that way. `false`
     * whenever the whole Provider is unavailable too, though the
     * `available: false` branch below doesn't carry either field: nothing
     * about a Facet matters once signing in with the Provider at all
     * doesn't work.
     */
    calendarApiEnabled: z.boolean(),
    contactsApiEnabled: z.boolean(),
  }),
  z.object({
    provider: registeredProviderSchema,
    available: z.literal(false),
    unavailableReason: providerUnavailableReasonSchema,
  }),
]);
export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;

/** `GET /auth/oauth/providers` (#116): one entry per Provider, in `PROVIDERS` order. Readable by any User — unlike Provider Health, it carries no Registration detail, only whether signing in is possible. */
export const providerAvailabilityListResponseSchema = z.object({
  providers: z.array(providerAvailabilitySchema),
});
export type ProviderAvailabilityListResponse = z.infer<
  typeof providerAvailabilityListResponseSchema
>;

/**
 * `POST /auth/oauth/:provider/start` (#116, #119, #202). Omitting every
 * field starts an `add_mail_account` attempt with the account chooser
 * shown; naming `mailAccountId` starts a `reauth` attempt instead — the same
 * door for "sign in again" on an OAuth account and "switch this password
 * account to a Grant". Naming `connectedAccountId` and `facet` together
 * starts an `add_facet` attempt: turning on Calendar or Contacts for that
 * already-connected identity by incremental consent (ADR-0022) — the two
 * always travel together, since a Facet grant with nothing to attach it to
 * (or vice versa) means nothing. Every case sets `login_hint` from a row
 * the start route already looked up itself, never from the Client.
 */
export const startProviderSignInRequestSchema = z
  .object({
    mailAccountId: z.string().min(1).optional(),
    connectedAccountId: z.string().min(1).optional(),
    facet: grantableFacetKindSchema.optional(),
  })
  .refine((data) => !(data.mailAccountId && data.connectedAccountId), {
    message: "mailAccountId and connectedAccountId are two different attempts; only one at a time.",
  })
  .refine((data) => Boolean(data.connectedAccountId) === Boolean(data.facet), {
    message: "connectedAccountId and facet are only meaningful together.",
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
  /**
   * ADR-0021: an M365 tenant blocked IMAP or withheld admin consent for this
   * Registration (#117). Distinct from `provider_error` because the fix is
   * asking the tenant's own admin, never retrying — nothing the Owner's
   * Registration or a second attempt can do about it.
   */
  "tenant_refused",
  /** An `add_facet` attempt's Grant widened the Connected Account's credential and a new Facet row now reads `active` (#202). */
  "facet_added",
  /**
   * An `add_facet` attempt whose Provider identity didn't match the
   * Connected Account's own (#202, ADR-0022: "the address the Provider
   * returns must match the account's own identity, exactly as reauth
   * already demands"). Deliberately its own outcome rather than reusing
   * `reauth_address_mismatch` — the ticket's own acceptance criterion asks
   * for a message "distinctly from a reauth mismatch", since nothing about
   * a Mail Account is even involved here.
   */
  "facet_grant_address_mismatch",
  /**
   * The consent screen came back without the Facet's own scope granted —
   * the User unchecked it, or otherwise partly declined (#202). No Facet
   * row was written and the stored credential is untouched.
   */
  "facet_grant_incomplete",
]);
export type OAuthSignInOutcome = z.infer<typeof oauthSignInOutcomeSchema>;
