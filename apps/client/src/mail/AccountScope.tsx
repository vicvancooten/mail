import type { MailAccount } from "@mail/shared";
import { useState } from "react";
import { Avatar } from "./Avatar.js";
import type { AccountScope as AccountScopeIds } from "./device-preferences.js";

/** "Accessible name states what is in Scope" (#73's acceptance criteria). */
function scopeAccessibleName(accounts: MailAccount[], scope: AccountScopeIds): string {
  if (scope.length >= accounts.length) return "Account Scope: All accounts";
  const named = accounts
    .filter((account) => scope.includes(account.id))
    .map((account) => account.emailAddress);
  return `Account Scope: ${named.join(", ")}`;
}

/**
 * Account Scope (#73, `mail#66` §"Account Scope in the Client's own chrome";
 * moved into the Hub in #96): one control, in `RootLayout.tsx`'s
 * `header-right`, that selects any non-empty subset of the User's Mail
 * Accounts — Client-level chrome rather than Mail-level, because narrowing
 * to one account is a question every App answers (`CONTEXT.md`'s own
 * definition names it as one of the five things the Hub holds). Replaces the
 * single-account `<select>` (`AccountSwitcher`, #40) it superseded: a Scope
 * is a *set*, so a checkbox per Mail Account is the accessible primitive a
 * `<select>` can't express.
 *
 * Renders nothing with a single Mail Account, same "nothing here worth
 * narrowing" guard `AccountSwitcher` had — which is also why it renders
 * unconditionally in the Hub rather than being Mail-specific: a placeholder
 * App with no Mail Account to scope shows nothing here either. "Cannot be
 * emptied" is enforced right here, per toggle —
 * `useAccountScope.ts#useAccountScope`'s own guard is this component's
 * backstop, not its only line of defense.
 */
export function AccountScope({
  accounts,
  scope,
  onChange,
}: {
  accounts: MailAccount[];
  scope: AccountScopeIds;
  onChange: (ids: AccountScopeIds) => void;
}) {
  const [open, setOpen] = useState(false);
  if (accounts.length <= 1) return null;

  const inScope = new Set(scope);
  // Stacked avatars (#73's acceptance criteria) when several accounts are in
  // Scope — capped at 3 so the stack itself never crowds the search field it
  // sits beside.
  const scopedAccounts = accounts.filter((account) => inScope.has(account.id));

  function toggle(id: string) {
    const next = inScope.has(id) ? scope.filter((existing) => existing !== id) : [...scope, id];
    if (next.length === 0) return;
    onChange(next);
  }

  return (
    <div className="account-scope">
      <button
        type="button"
        className="account-scope-toggle"
        aria-expanded={open}
        aria-label={scopeAccessibleName(accounts, scope)}
        title="Account Scope"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="account-scope-avatars">
          {scopedAccounts.slice(0, 3).map((account) => (
            <Avatar key={account.id} name={account.emailAddress} />
          ))}
        </span>
      </button>
      {open ? (
        <fieldset className="account-scope-panel">
          <legend>Account Scope</legend>
          {accounts.map((account) => (
            <label key={account.id}>
              <input
                type="checkbox"
                checked={inScope.has(account.id)}
                onChange={() => toggle(account.id)}
              />
              {account.emailAddress}
              {account.status === "needs_reauth" ? " (needs reauth)" : ""}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
