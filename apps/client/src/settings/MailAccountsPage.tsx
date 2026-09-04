import { MailAccountsSection } from "../mail-accounts/MailAccountsSection.js";
import { SignatureEditor } from "../mail-accounts/SignatureEditor.js";
import { rootRoute } from "../router/routes.js";
import { enqueueMutation, useMailAccounts } from "../store/index.js";

/**
 * Settings' Mail Accounts page (#99): the account list, add flow and Needs
 * Reauth form (`MailAccountsSection`, unchanged since #33) plus each
 * account's own signature and notifications toggle — split out of the old
 * monolithic `SettingsSection`'s "Mail Account preferences" block, minus its
 * Gatekeeper sub-section, which is its own page now (#99, `GatekeeperPage`).
 *
 * `mailAccountSettingsAnchorId`/`scrollToMailAccountSettings`
 * (`mail-accounts/MailAccountsSection.tsx`) still name a row inside
 * `MailAccountsSection` itself, so a `needs_reauth` notification click still
 * lands on the right row once `router/RootLayout.tsx` navigates here
 * (`/settings/mail-accounts`).
 */
export function MailAccountsPage() {
  const mailAccounts = useMailAccounts() ?? [];
  // Only to choose the wording for an unregistered Provider (#116,
  // ADR-0021): the Owner is told where to fix it, a Member whom to ask.
  // The same seam `SettingsLayout` reads the role through.
  const { user } = rootRoute.useRouteContext();

  return (
    <section className="settings-page">
      <h2>Mail Accounts</h2>
      <MailAccountsSection isOwner={user.role === "owner"} />

      {mailAccounts.length > 0 && (
        <section>
          <h3>Account preferences</h3>
          {mailAccounts.map((account) => (
            <div key={account.id} className="account-preferences">
              <strong>{account.emailAddress}</strong>
              <SignatureEditor account={account} />
              <label>
                <input
                  type="checkbox"
                  checked={account.notificationsEnabled}
                  onChange={(event) =>
                    void enqueueMutation(
                      { type: "setNotificationsEnabled", enabled: event.target.checked },
                      account.id,
                    )
                  }
                />
                Notifications
              </label>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
