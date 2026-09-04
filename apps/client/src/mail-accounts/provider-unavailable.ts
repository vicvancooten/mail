import type { ProviderUnavailableReason } from "@mail/shared";
import { PROVIDER_LABEL } from "./provider-labels.js";

/**
 * The unavailable wording for a Provider choice (ADR-0021): shared between
 * adding a Mail Account (`ProviderSignInChoice`) and every reauth affordance
 * (`ProviderReauthAction`) — #119's acceptance criteria says "sign-in-again
 * on an unregistered Provider ... shows the same unavailable wording as
 * adding", so there is exactly one place this text is written.
 */
export function describeProviderUnavailable(
  provider: keyof typeof PROVIDER_LABEL,
  reason: ProviderUnavailableReason,
  isOwner: boolean,
): { message: string; ownerHref: string | null } {
  const label = PROVIDER_LABEL[provider];
  if (reason === "not_supported") {
    return { message: `Signing in with ${label} isn't supported yet.`, ownerHref: null };
  }
  return isOwner
    ? { message: `${label} isn't set up on this instance yet —`, ownerHref: "/settings/instance" }
    : { message: `${label} isn't set up on this instance yet, ask the Owner.`, ownerHref: null };
}
