import type { MailAccount } from "@mail/shared";
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
 * moved into the Hub in #96): the live, persisted set of Mail Accounts the
 * Thread list draws from — `useThreadWindow`'s own doc comment covers the
 * merge this feeds. Defaults to every Mail Account, the same "narrowing to
 * one account is a question every App answers, and the answer starts as 'no
 * narrowing'" the parent ticket (#66) describes.
 *
 * Built on `useSyncExternalStore` (`device-preferences.ts#subscribeAccountScope`),
 * the same reactive shape #99 gave view mode/density/sidebar-collapsed: #96
 * moves the *control* itself into `RootLayout.tsx`'s Hub while
 * `MailSection.tsx` still calls this hook to filter its own Thread list —
 * without a shared store the two would render two independent copies of
 * Scope that could drift the moment either wrote.
 *
 * Resolved fresh against `mailAccounts` on every read — an added, removed,
 * or re-authed account is what keeps a stale stored id (or a first-ever
 * read with nothing stored) from ever leaving Scope empty; see
 * `device-preferences.ts#resolveAccountScope`. `setScope` is the one place
 * "cannot be emptied" (#73's acceptance criteria) is enforced against a
 * caller-supplied set — the control itself (`AccountScope.tsx`) enforces the
 * same rule per-toggle, this is the seam's own backstop.
 */
export function useAccountScope(mailAccounts: MailAccount[] | undefined): {
  scope: AccountScope;
  setScope: (ids: AccountScope) => void;
} {
  const stored = useSyncExternalStore(subscribeAccountScope, readAccountScope, () => null);
  const scope =
    mailAccounts && mailAccounts.length > 0
      ? resolveAccountScope(stored, mailAccounts)
      : EMPTY_SCOPE;

  const setScope = useCallback((ids: AccountScope) => {
    if (ids.length === 0) return;
    writeAccountScope(ids);
  }, []);

  return { scope, setScope };
}
