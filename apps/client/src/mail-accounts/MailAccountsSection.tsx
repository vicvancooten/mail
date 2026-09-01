import type { MailAccount } from "@mail/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchMailAccounts } from "../api/mail-accounts.js";
import { AddMailAccountForm } from "./AddMailAccountForm.js";
import { ReauthMailAccountForm } from "./ReauthMailAccountForm.js";

/**
 * The DOM anchor a `needs_reauth` notification click scrolls to (#53,
 * ADR-0015: "that Mail Account's settings ... for Needs Reauth"). There is
 * no router here (`AppShell`'s own doc comment), so "navigate to this Mail
 * Account's settings" means scrolling this always-rendered section's
 * matching row into view rather than changing a URL — see
 * `scrollToMailAccountSettings` below, called from `MailSection.tsx`'s
 * notification-target effect.
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
 */
export function MailAccountsSection() {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    return fetchMailAccounts()
      .then((result) => setAccounts(result.mailAccounts))
      .catch(() => setError("Couldn't load Mail Accounts."));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <section>
      <h3>Mail Accounts</h3>
      {error && <p role="alert">{error}</p>}

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
                  <ReauthMailAccountForm mailAccountId={account.id} onResumed={reload} />
                </>
              ) : (
                <span> — connected</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddMailAccountForm
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
