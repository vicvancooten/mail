import type { ConnectedAccount, MailAccount } from "@mail/shared";
import { useCallback, useSyncExternalStore } from "react";
import {
  type AccountScope,
  readAccountScope,
  resolveAccountScope,
  subscribeAccountScope,
  writeAccountScope,
} from "./device-preferences.js";

const EMPTY_SCOPE: AccountScope = [];

/**
 * Account Scope (#73, `mail#66` §"Account Scope in the Client's own chrome";
 * moved into the Hub in #96; repointed at Connected Accounts in #207): the
 * live, persisted set of Connected Accounts the Hub's picker
 * (`AccountScope.tsx`) shows checked. Defaults to every Connected Account,
 * the same "narrowing to one account is a question every App answers, and
 * the answer starts as 'no narrowing'" the parent ticket (#66) describes.
 *
 * Built on `useSyncExternalStore` (`device-preferences.ts#subscribeAccountScope`),
 * the same reactive shape #99 gave view mode/density/sidebar-collapsed:
 * `RootLayout.tsx` reads this directly to drive the picker, while
 * `MailSection.tsx` reads it too and narrows it further to just the Mail
 * Facets in Scope (`deriveMailAccountScope` below) — without a shared store
 * the two would render two independent copies of Scope that could drift the
 * moment either wrote.
 *
 * Resolved fresh against `connectedAccounts` on every read — an added,
 * removed, or re-authed account is what keeps a stale stored id (or a
 * first-ever read with nothing stored) from ever leaving Scope empty; see
 * `device-preferences.ts#resolveAccountScope`. `setScope` is the one place
 * "cannot be emptied" (#73's acceptance criteria) is enforced against a
 * caller-supplied set — the control itself (`AccountScope.tsx`) enforces the
 * same rule per-toggle, this is the seam's own backstop.
 */
export function useAccountScope(connectedAccounts: ConnectedAccount[] | undefined): {
  scope: AccountScope;
  setScope: (ids: AccountScope) => void;
} {
  const stored = useSyncExternalStore(subscribeAccountScope, readAccountScope, () => null);
  const scope =
    connectedAccounts && connectedAccounts.length > 0
      ? resolveAccountScope(stored, connectedAccounts)
      : EMPTY_SCOPE;

  const setScope = useCallback((ids: AccountScope) => {
    if (ids.length === 0) return;
    writeAccountScope(ids);
  }, []);

  return { scope, setScope };
}

/**
 * Mail's own view of Account Scope (#207): which Mail Accounts are in
 * scope, derived from the Connected Account Scope above rather than tracked
 * separately — "Mail narrows by the Mail Facets in Scope, exactly as it
 * does today" (#207's acceptance criteria) means a Connected Account with no
 * Mail Facet in Scope contributes nothing here, which can legitimately
 * narrow Mail down to zero accounts (an all-muted selection) without that
 * being an error to correct.
 *
 * Falls back to *every* Mail Account, bypassing `connectedAccountScope`
 * entirely, while the Connected Accounts collection itself hasn't synced
 * yet (`connectedAccounts` empty/undefined) — the same "nothing to narrow
 * yet" posture a cold Local Cache already gets everywhere else in this file,
 * and what keeps a Mail Account whose parent Connected Account hasn't
 * arrived over `/sync` yet from spuriously vanishing from the Thread list.
 * Once the Connected Accounts collection is present, an account with no
 * matching row is simply excluded — the same "stale id, drop it" rule
 * `resolveAccountScope` applies at the Connected Account layer.
 */
export function deriveMailAccountScope(
  connectedAccounts: ConnectedAccount[] | undefined,
  connectedAccountScope: AccountScope,
  mailAccounts: readonly MailAccount[],
): AccountScope {
  if (!connectedAccounts || connectedAccounts.length === 0) {
    return mailAccounts.map((account) => account.id);
  }
  const inScope = new Set(connectedAccountScope);
  return mailAccounts
    .filter((account) => inScope.has(account.connectedAccountId))
    .map((account) => account.id);
}
