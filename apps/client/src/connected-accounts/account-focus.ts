import { type ConnectedAccountFacetKind, connectedAccountFacetKindSchema } from "@mail/shared";

/**
 * The `needs-reauth` notification deep link's landing params (#201, #204,
 * `router/RootLayout.tsx`'s notification-target effect): which Facet's Badge
 * to focus once `/settings/connected-accounts` has rendered. `account` names
 * a **Connected Account** id (widened by #204 from a Mail Account id, since a
 * click can now land on a Calendar or Contacts Facet with no Mail Account at
 * all) and `facet` names which of that account's Facet cells to open — both
 * required together, or neither resolves. Replaces
 * `mail-accounts/MailAccountsSection.tsx`'s old
 * `mailAccountSettingsAnchorId`/`scrollToMailAccountSettings` DOM-id
 * scrolling — there's no longer one row per account to scroll to, since a
 * table cell can hold several accounts' Badges, so the target is carried as
 * query params and resolved to a Badge once the table has the data to find
 * it. Plain `window.location`/`history`, the same reasoning
 * `mail-accounts/sign-in-outcome.ts` gives for `?oauth=`: this also has to
 * survive a cold start racing the first render, and clearing it must not add
 * a history entry.
 */
export const ACCOUNT_FOCUS_PARAM = "account";
export const FACET_FOCUS_PARAM = "facet";

export interface AccountFocus {
  connectedAccountId: string;
  facet: ConnectedAccountFacetKind;
}

/** Reads the Connected Account id and Facet to focus out of a query string, or null when there isn't a complete pair. */
export function readAccountFocus(search: string): AccountFocus | null {
  const params = new URLSearchParams(search);
  const connectedAccountId = params.get(ACCOUNT_FOCUS_PARAM);
  const facetResult = connectedAccountFacetKindSchema.safeParse(params.get(FACET_FOCUS_PARAM));
  if (!connectedAccountId || !facetResult.success) return null;
  return { connectedAccountId, facet: facetResult.data };
}

/** Drops both focus parameters without a navigation, so Back or a reload doesn't re-scroll/re-open it. */
export function clearAccountFocus(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ACCOUNT_FOCUS_PARAM) && !url.searchParams.has(FACET_FOCUS_PARAM)) {
    return;
  }
  url.searchParams.delete(ACCOUNT_FOCUS_PARAM);
  url.searchParams.delete(FACET_FOCUS_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
