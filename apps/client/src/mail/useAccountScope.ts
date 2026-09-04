import type { MailAccount } from "@mail/shared";
import { useCallback, useEffect, useState } from "react";
import {
  type AccountScope,
  readAccountScope,
  resolveAccountScope,
  writeAccountScope,
} from "./device-preferences.js";

/**
 * Account Scope (#73, `mail#66` §"Account Scope in the Client's own chrome"):
 * the live, persisted set of Mail Accounts the Thread list draws from —
 * `useThreadWindow`'s own doc comment covers the merge this feeds. Defaults
 * to every Mail Account, the same "narrowing to one account is a question
 * every App answers, and the answer starts as 'no narrowing'" the parent
 * ticket (#66) describes.
 *
 * Resolved fresh against `mailAccounts` on every change — an added, removed,
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
  const [scope, setScopeState] = useState<AccountScope>([]);

  useEffect(() => {
    if (!mailAccounts || mailAccounts.length === 0) return;
    setScopeState((current) =>
      resolveAccountScope(current.length > 0 ? current : readAccountScope(), mailAccounts),
    );
  }, [mailAccounts]);

  const setScope = useCallback((ids: AccountScope) => {
    if (ids.length === 0) return;
    setScopeState(ids);
    writeAccountScope(ids);
  }, []);

  return { scope, setScope };
}
