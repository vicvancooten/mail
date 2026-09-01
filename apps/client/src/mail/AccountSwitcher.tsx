import type { MailAccount } from "@mail/shared";
import { Mail } from "lucide-react";

/**
 * Per-account inboxes with an account switcher (#40's first acceptance
 * box): choosing a different Mail Account swaps which one's window the
 * list and detail panes render. A native `<select>` rather than a custom
 * dropdown — one Mail Account or several, this is a single accessible
 * control and there is nothing here worth a bespoke widget yet.
 */
export function AccountSwitcher({
  accounts,
  selectedId,
  onSelect,
}: {
  accounts: MailAccount[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (accounts.length <= 1) return null;

  return (
    <label className="account-switcher">
      <Mail size={14} />
      <select
        aria-label="Mail account"
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.emailAddress}
            {account.status === "needs_reauth" ? " (needs reauth)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
