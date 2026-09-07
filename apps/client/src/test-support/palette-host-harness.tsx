import type { ReactNode } from "react";
import { PaletteHostProvider } from "../mail/command-palette/PaletteHostContext.js";
import { useAccountScope } from "../mail/useAccountScope.js";
import { useMailAccounts } from "../store/index.js";

/**
 * Stands in for `router/RootLayout.tsx`'s own `PaletteHostProvider` (#147)
 * in a test that renders `MailSection`/`stream/StreamStack`/`Screener` on
 * their own, without the full router tree `app-shell-integration.test.tsx`
 * exercises — the same "stand in for the Hub" reasoning
 * `search-integration.test.tsx`'s own (now-retired) `AccountScopeHarness`
 * used. Reads the same reactive `mailAccounts`/`useAccountScope` pair the
 * Hub itself does, so a test that changes Mail Accounts or Account Scope
 * sees the identical session `MailSection` would.
 */
export function PaletteHostTestProvider({ children }: { children: ReactNode }) {
  const mailAccounts = useMailAccounts() ?? [];
  const { scope: accountScope } = useAccountScope(mailAccounts);
  return (
    <PaletteHostProvider accountScope={accountScope} mailAccounts={mailAccounts}>
      {children}
    </PaletteHostProvider>
  );
}
