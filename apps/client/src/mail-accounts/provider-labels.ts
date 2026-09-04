import type { Provider } from "@mail/shared";

/** The display name for each Provider — shared between the add-account choice and every reauth affordance. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};
