import type { ConnectedAccount, ConnectedAccountFacetKind } from "@mail/shared";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { FACET_COLUMNS, FACET_LABEL } from "../connected-accounts/provider-table.js";
import { Avatar } from "./Avatar.js";
import type { AccountScope as AccountScopeIds } from "./device-preferences.js";

/** "Accessible name states what is in Scope" (#73's acceptance criteria). */
function scopeAccessibleName(accounts: ConnectedAccount[], scope: AccountScopeIds): string {
  if (scope.length >= accounts.length) return "Account Scope: All accounts";
  const named = accounts
    .filter((account) => scope.includes(account.id))
    .map((account) => account.identity);
  return `Account Scope: ${named.join(", ")}`;
}

/** Which Facets an account has turned on, in `FACET_COLUMNS`' fixed order — a stable row of dots rather than one that reorders itself as Facets are added or removed. */
function activeFacets(account: ConnectedAccount): readonly ConnectedAccountFacetKind[] {
  return FACET_COLUMNS.filter((facet) =>
    account.facets.some((candidate) => candidate.kind === facet),
  );
}

/**
 * Account Scope (#73, `mail#66` §"Account Scope in the Client's own chrome";
 * moved into the Hub in #96; repointed at **Connected Accounts** in #207):
 * one control, in `RootLayout.tsx`'s `header-right`, that selects any
 * non-empty subset of the User's Connected Accounts — Client-level chrome
 * rather than Mail-level, because narrowing to one account is a question
 * every App answers (`CONTEXT.md`'s own definition names it as one of the
 * five things the Hub holds). A Local collection (Tasks, Notes) is never one
 * of these rows — it belongs to the User alone, not to any Connected
 * Account, so there's nothing here for it to narrow (`apps.ts#AppDef.observesAccountScope`
 * hides the whole control for those Apps instead).
 *
 * Each row is the account's `identity` plus a small dot per Facet it
 * carries (`activeFacets` above) — "what an account actually feeds is
 * visible in the picker" (#207's acceptance criteria), the same status-dot
 * language `connected-accounts/ConnectedAccountFacetBadge.tsx` already
 * established for the Settings table, reused here rather than reinvented.
 * An account with none of `activeFacet` — the current App's own Facet,
 * `apps.ts#accountScopeFacetForApp` — renders `account-scope-muted`:
 * **listed and checkable, never hidden or disabled**, just visibly dimmed,
 * so a User who narrows to a Calendar-only account while Mail is open can
 * see *why* nothing in the Thread list changed rather than assume Scope
 * broke.
 *
 * Renders nothing with a single Connected Account, same "nothing here worth
 * narrowing" guard this had pre-#207 — which is also why it renders
 * unconditionally in the Hub rather than being Mail-specific: a placeholder
 * App with no Connected Account to scope shows nothing here either. "Cannot
 * be emptied" is enforced right here, per toggle —
 * `useAccountScope.ts#useAccountScope`'s own guard is this component's
 * backstop, not its only line of defense.
 *
 * The panel is a shadcn `Popover` (#281 — moved off its own hand-managed
 * `open` boolean, the confirmed offender behind two transient surfaces being
 * open at once): portalled, closes on outside click and Escape, returns
 * focus to the trigger, all via Radix rather than a bespoke listener — the
 * same primitive `ThreadRow.tsx`'s Snooze menu and `LabelPicker` already
 * used. See `apps/client/DESIGN.md`'s "Transient surfaces" section for the
 * rule this enforces and its two exemptions.
 */
export function AccountScope({
  accounts,
  scope,
  activeFacet,
  onChange,
}: {
  accounts: ConnectedAccount[];
  scope: AccountScopeIds;
  /** The current App's own Facet (#207, `apps.ts#accountScopeFacetForApp`) — what decides which rows render muted. */
  activeFacet: ConnectedAccountFacetKind;
  onChange: (ids: AccountScopeIds) => void;
}) {
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
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="account-scope-toggle"
            aria-label={scopeAccessibleName(accounts, scope)}
            title="Account Scope"
          >
            <span className="account-scope-avatars">
              {scopedAccounts.slice(0, 3).map((account) => (
                <Avatar key={account.id} name={account.identity} />
              ))}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="account-scope-content">
          <fieldset className="account-scope-panel">
            <legend>Account Scope</legend>
            {accounts.map((account) => {
              const facets = activeFacets(account);
              const muted = !facets.includes(activeFacet);
              return (
                <label key={account.id} className={muted ? "account-scope-muted" : undefined}>
                  <input
                    type="checkbox"
                    checked={inScope.has(account.id)}
                    onChange={() => toggle(account.id)}
                  />
                  <span className="account-scope-identity">
                    {account.identity}
                    {account.status === "needs_reauth" ? " (needs reauth)" : ""}
                  </span>
                  {/* `aria-hidden` on the whole group, not just each dot —
                      the row's accessible name comes from the checkbox's own
                      label text alone (identity + reauth suffix), same as
                      pre-#207; a `title` per dot is the (sighted,
                      hover-only) detail. */}
                  <span className="account-scope-facets" aria-hidden="true">
                    {facets.map((facet) => (
                      <span
                        key={facet}
                        className={`account-scope-facet-dot account-scope-facet-dot--${facet}`}
                        title={FACET_LABEL[facet]}
                      />
                    ))}
                  </span>
                </label>
              );
            })}
          </fieldset>
        </PopoverContent>
      </Popover>
    </div>
  );
}
