import type { ConnectedAccountFacetKind, Provider, ProviderUnavailableReason } from "@mail/shared";
import { PROVIDER_LABEL } from "../mail-accounts/provider-labels.js";
import { describeProviderUnavailable } from "../mail-accounts/provider-unavailable.js";
import { FACET_LABEL } from "./provider-table.js";

/**
 * The three reasons a Facet's "+" never offers a consent flow (#202,
 * ADR-0022): the whole Provider is unavailable (`describeProviderUnavailable`'s
 * own two reasons), or the Provider is registered but the Owner hasn't
 * declared this Facet's API enabled on it — the one reason unique to a
 * single Facet rather than the whole Provider.
 */
export type FacetUnavailableReason = ProviderUnavailableReason | "api_disabled";

/**
 * The unavailable wording for one Facet at one Provider — `describeProviderUnavailable`'s
 * own sibling, phrased in the Facet rather than the Provider whenever the
 * reason is specific to it. `provider` is narrowed to the two Providers a
 * Facet's "+" ever offers (`provider-table.ts#providersServingFacet`), which
 * happen to be exactly `describeProviderUnavailable`'s own `RegisteredProvider`.
 */
export function describeFacetUnavailable(
  facet: ConnectedAccountFacetKind,
  provider: Extract<Provider, "google" | "microsoft">,
  reason: FacetUnavailableReason,
  isOwner: boolean,
): { message: string; ownerHref: string | null } {
  if (reason !== "api_disabled") {
    return describeProviderUnavailable(provider, reason, isOwner);
  }
  const providerLabel = PROVIDER_LABEL[provider];
  const facetLabel = FACET_LABEL[facet];
  return isOwner
    ? {
        message: `${facetLabel} isn't enabled on this instance's ${providerLabel} Registration yet —`,
        ownerHref: "/settings/instance",
      }
    : {
        message: `${facetLabel} isn't enabled on this instance's ${providerLabel} Registration yet, ask the Owner.`,
        ownerHref: null,
      };
}
