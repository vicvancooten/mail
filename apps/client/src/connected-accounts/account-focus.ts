/**
 * The `needs-reauth` notification deep link's landing param (#201,
 * `router/RootLayout.tsx`'s notification-target effect): which Mail
 * Account's row to focus once `/settings/connected-accounts` has rendered.
 * Replaces `mail-accounts/MailAccountsSection.tsx`'s old
 * `mailAccountSettingsAnchorId`/`scrollToMailAccountSettings` DOM-id
 * scrolling — there's no longer one row per account to scroll to, since a
 * table cell can hold several accounts' Badges, so the target is carried as
 * a query param and resolved to a Badge once the table has the data to find
 * it. Plain `window.location`/`history`, the same reasoning
 * `mail-accounts/sign-in-outcome.ts` gives for `?oauth=`: this also has to
 * survive a cold start racing the first render, and clearing it must not
 * add a history entry.
 */
export const ACCOUNT_FOCUS_PARAM = "account";

/** Reads the Mail Account id to focus out of a query string, or null when there isn't one. */
export function readAccountFocus(search: string): string | null {
  return new URLSearchParams(search).get(ACCOUNT_FOCUS_PARAM);
}

/** Drops the focus parameter without a navigation, so Back or a reload doesn't re-scroll/re-open it. */
export function clearAccountFocus(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(ACCOUNT_FOCUS_PARAM)) return;
  url.searchParams.delete(ACCOUNT_FOCUS_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
