import { OAUTH_SIGN_IN_OUTCOME_PARAM, type OAuthSignInOutcome } from "@mail/shared";

/**
 * The other end of `routes/oauth-signin.ts`'s redirect (#116): the browser
 * comes back from the Provider to `/settings/mail-accounts?oauth=<outcome>`,
 * and this turns that one query parameter into something to say. Every
 * failure means nothing was created, so every message is plain and none of
 * them asks the User to undo anything.
 *
 * Plain `window.location`/`history` rather than the router's own search
 * params: the value arrives on a full-page load from outside the app (the
 * router has no route match to hand it over from), and clearing it must not
 * add a history entry — pressing Back should not re-show the toast.
 */

const MESSAGES: Record<OAuthSignInOutcome, string> = {
  signed_in: "Signed in. The new Mail Account is syncing now.",
  cancelled: "Sign-in cancelled — no Mail Account was added.",
  session_expired: "Your session expired during sign-in. Sign in again and retry.",
  invalid_state: "That sign-in link has already been used or has expired. Try again.",
  duplicate_address: "That address is already one of your Mail Accounts.",
  verification_failed:
    "Signed in, but the mail server wouldn't accept the connection — no Mail Account was added.",
  provider_error: "The provider couldn't complete the sign-in. Nothing was added; try again.",
  provider_not_registered:
    "That provider is no longer set up on this instance. Ask the Owner, then try again.",
  reauth_succeeded: "Signed in again. This Mail Account is syncing normally now.",
  reauth_address_mismatch:
    "That account doesn't match this Mail Account's address. Sign in with the matching account instead.",
};

/** The outcomes that leave the account list stale — a new row, or a replaced credential. */
const SUCCESS_OUTCOMES: ReadonlySet<OAuthSignInOutcome> = new Set([
  "signed_in",
  "reauth_succeeded",
]);

export interface SignInOutcome {
  outcome: OAuthSignInOutcome;
  message: string;
  /** The only outcomes the account list needs reloading for. */
  succeeded: boolean;
}

/** Reads the outcome out of a query string, or null when this wasn't a return from a Provider. */
export function readSignInOutcome(search: string): SignInOutcome | null {
  const value = new URLSearchParams(search).get(OAUTH_SIGN_IN_OUTCOME_PARAM);
  if (!value || !(value in MESSAGES)) {
    return null;
  }
  const outcome = value as OAuthSignInOutcome;
  return { outcome, message: MESSAGES[outcome], succeeded: SUCCESS_OUTCOMES.has(outcome) };
}

/**
 * Drops the outcome parameter from the address bar without a navigation, so
 * a reload or a shared URL doesn't resurrect a toast about something that
 * already happened. Leaves every other parameter alone.
 */
export function clearSignInOutcome(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(OAUTH_SIGN_IN_OUTCOME_PARAM)) return;
  url.searchParams.delete(OAUTH_SIGN_IN_OUTCOME_PARAM);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
