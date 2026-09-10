import type { ConnectedAccountFacetKind, Provider } from "@mail/shared";
import { PROVIDERS } from "@mail/shared";

/**
 * The Connected Accounts table's row order and labels (#201, #172 Variant C):
 * every `Provider`, not just the two `RegisteredProvider`s
 * `mail-accounts/provider-labels.ts#PROVIDER_LABEL` covers — CalDAV/CardDAV
 * and Other IMAP never have a Provider Registration, but they're still rows.
 */
export const PROVIDER_TABLE_LABEL: Record<Provider, string> = {
  google: "Google",
  microsoft: "Microsoft",
  caldav_carddav: "CalDAV/CardDAV",
  other_imap: "Other IMAP",
};

/** Row order — `PROVIDERS`' own order already puts Google and Microsoft first. */
export const PROVIDER_TABLE_ROWS: readonly Provider[] = PROVIDERS;

export const FACET_COLUMNS: readonly ConnectedAccountFacetKind[] = ["mail", "calendar", "contacts"];

export const FACET_LABEL: Record<ConnectedAccountFacetKind, string> = {
  mail: "Mail",
  calendar: "Calendar",
  contacts: "Contacts",
};

/**
 * Which Facets each Provider can actually carry (#201's acceptance
 * criterion — "an impossible cell ... is an em dash"). Other IMAP is a
 * plain mailbox, never Calendar/Contacts; CalDAV/CardDAV is the opposite —
 * a mailbox is never what that identity kind is for.
 */
export const FACET_SUPPORTED_BY_PROVIDER: Record<Provider, readonly ConnectedAccountFacetKind[]> = {
  google: ["mail", "calendar", "contacts"],
  microsoft: ["mail", "calendar", "contacts"],
  caldav_carddav: ["calendar", "contacts"],
  other_imap: ["mail"],
};

export function facetSupportedByProvider(
  provider: Provider,
  facet: ConnectedAccountFacetKind,
): boolean {
  return FACET_SUPPORTED_BY_PROVIDER[provider].includes(facet);
}

/** The Providers that can serve a given Facet — what the below-table "Add a …" entry point offers. */
export function providersServingFacet(facet: ConnectedAccountFacetKind): readonly Provider[] {
  return PROVIDER_TABLE_ROWS.filter((provider) => facetSupportedByProvider(provider, facet));
}
