import type { MailAccount } from "@mail/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchMailAccounts } from "../api/mail-accounts.js";
import { AddMailAccountForm } from "./AddMailAccountForm.js";
import { ProviderReauthAction } from "./ProviderReauthAction.js";
import { PROVIDER_LABEL } from "./provider-labels.js";
import { ReauthMailAccountForm } from "./ReauthMailAccountForm.js";
import { clearSignInOutcome, readSignInOutcome, type SignInOutcome } from "./sign-in-outcome.js";

/**
 * The DOM anchor a `needs_reauth` notification click scrolls to (#53,
 * ADR-0015: "that Mail Account's settings ... for Needs Reauth"). Settings
 * is a route now (#71, `router/routes.ts#settingsRoute`), which gets the
 * click to the right *screen*; this is still what gets it to the right
 * *row* within it, once this section has rendered — see
 * `scrollToMailAccountSettings` below, called from `router/RootLayout.tsx`'s
 * notification-target effect after it navigates there.
 */
export function mailAccountSettingsAnchorId(mailAccountId: string): string {
  return `mail-account-${mailAccountId}`;
}

/** Scrolls a `needs_reauth` notification click's target Mail Account row into view — a no-op if `MailAccountsSection` hasn't rendered it (yet, or at all). */
export function scrollToMailAccountSettings(mailAccountId: string): void {
  document
    .getElementById(mailAccountSettingsAnchorId(mailAccountId))
    ?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * The account list UI (#33): every Mail Account this User owns
 * (ADR-0004 — never another User's), a Needs Reauth badge with its
 * re-enter-credentials form inline, and the add-a-Mail-Account flow. No
 * credential ever appears here — the wire type has no field for one
 * (ADR-0003).
 *
 * Its own `fetchMailAccounts` call, entirely independent of Account Scope
 * (#73's own doc comment) — this is what "Settings lists every Mail Account
 * regardless of Scope, with Needs Reauth shown per account" (#73's
 * acceptance criteria) already means: a User who has filtered an account out
 * of Scope can still reach it here to fix it.
 */
export function MailAccountsSection({ isOwner = false }: { isOwner?: boolean } = {}) {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [signInOutcome, setSignInOutcome] = useState<SignInOutcome | null>(null);

  const reload = useCallback(() => {
    return fetchMailAccounts()
      .then((result) => setAccounts(result.mailAccounts))
      .catch(() => setError("Couldn't load Mail Accounts."));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // The return leg of a Provider sign-in (#116): the callback redirected
  // here with an outcome in the query string. Read it once, then clear it,
  // so a reload or a shared URL can't resurrect a toast about something that
  // already happened. A success means the account was created while the
  // browser was away — nothing local knows about it until this reload.
  useEffect(() => {
    const outcome = readSignInOutcome(window.location.search);
    if (!outcome) return;
    setSignInOutcome(outcome);
    clearSignInOutcome();
    if (outcome.succeeded) void reload();
  }, [reload]);

  return (
    <section>
      <h3>Mail Accounts</h3>
      {error && <p role="alert">{error}</p>}

      {signInOutcome && (
        <p role="status">
          {signInOutcome.message}{" "}
          <button type="button" onClick={() => setSignInOutcome(null)}>
            Dismiss
          </button>
        </p>
      )}

      {accounts === null && <p>Loading…</p>}

      {accounts !== null && accounts.length === 0 && !adding && <p>No Mail Accounts yet.</p>}

      {accounts !== null && accounts.length > 0 && (
        <ul>
          {accounts.map((account) => (
            <li key={account.id} id={mailAccountSettingsAnchorId(account.id)}>
              <strong>{account.emailAddress}</strong>
              {account.status === "needs_reauth" ? (
                <>
                  <p role="status">
                    Needs Reauth — the mail server rejected the stored credential.
                  </p>
                  {account.authKind.kind === "oauth" ? (
                    // Never a password form (#119, ADR-0021 user story 27):
                    // recovery matches how the Grant was set up.
                    <ProviderReauthAction
                      mailAccountId={account.id}
                      provider={account.authKind.provider}
                      label={`Sign in with ${PROVIDER_LABEL[account.authKind.provider]} again`}
                      isOwner={isOwner}
                    />
                  ) : (
                    <ReauthMailAccountForm mailAccountId={account.id} onResumed={reload} />
                  )}
                </>
              ) : (
                <span> — connected</span>
              )}
              {account.authKind.kind === "password" && (
                // The same door a Gmail app-password account uses to switch
                // to a Grant on this same Mail Account (#119, ADR-0021 user
                // story 29) — offered regardless of status, not only Needs
                // Reauth.
                <ProviderReauthAction
                  mailAccountId={account.id}
                  provider="google"
                  label="Switch to Google sign-in"
                  isOwner={isOwner}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddMailAccountForm
          isOwner={isOwner}
          onAdded={() => {
            setAdding(false);
            reload();
          }}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          Add a Mail Account
        </button>
      )}
    </section>
  );
}
