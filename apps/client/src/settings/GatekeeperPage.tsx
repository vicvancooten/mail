import { useMailAccounts } from "../store/index.js";
import { GatekeeperSection } from "./GatekeeperSection.js";

/**
 * Settings' Gatekeeper page (#99): the existing per-account
 * `GatekeeperSection` (enable/disable, Reset, Blocked Senders — #56),
 * pulled out of the old monolithic `SettingsSection`'s per-account block
 * into its own page.
 *
 * Blocked Aliases (CONTEXT.md's Blocked Alias) is deliberately not here yet:
 * that's #103's own recipient-keyed Verdict, a sibling ticket under the same
 * epic (#90) that hadn't landed when this page was built — there is no
 * backend support to render a list against. This page gets the one home
 * the issue names for it the moment #103 ships.
 */
export function GatekeeperPage() {
  const mailAccounts = useMailAccounts() ?? [];

  return (
    <section className="settings-page">
      <h2>Gatekeeper</h2>
      {/* `GatekeeperSection` already names its own account in an `<h4>`
          ("Gatekeeper — {email}") — no extra wrapper needed here, unlike
          `MailAccountsPage`'s `.account-preferences` grouping, which shares
          one heading across signature *and* notifications. */}
      {mailAccounts.map((account) => (
        <GatekeeperSection key={account.id} account={account} />
      ))}
    </section>
  );
}
