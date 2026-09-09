import type { ReactNode } from "react";
import { PaletteHostProvider } from "../mail/command-palette/PaletteHostContext.js";
import { deriveMailAccountScope, useAccountScope } from "../mail/useAccountScope.js";
import { useConnectedAccounts, useMailAccounts } from "../store/index.js";

/**
 * Stands in for `router/RootLayout.tsx`'s own `PaletteHostProvider` (#147)
 * in a test that renders `MailSection`/`stream/StreamStack`/`Screener` on
 * their own, without the full router tree `app-shell-integration.test.tsx`
 * exercises — the same "stand in for the Hub" reasoning
 * `search-integration.test.tsx`'s own (now-retired) `AccountScopeHarness`
 * used. Reads the same reactive `mailAccounts`/`connectedAccounts`/`useAccountScope`
 * trio the Hub itself does (#207: Account Scope reads Connected Accounts,
 * `deriveMailAccountScope`d down to the Mail-Account-scoped set the Palette's
 * own search actually needs), so a test that changes Mail Accounts,
 * Connected Accounts, or Account Scope sees the identical session
 * `MailSection` would.
 */
export function PaletteHostTestProvider({ children }: { children: ReactNode }) {
  const mailAccounts = useMailAccounts() ?? [];
  const connectedAccounts = useConnectedAccounts() ?? [];
  const { scope: connectedAccountScope } = useAccountScope(connectedAccounts);
  const accountScope = deriveMailAccountScope(
    connectedAccounts,
    connectedAccountScope,
    mailAccounts,
  );
  return (
    <PaletteHostProvider accountScope={accountScope} mailAccounts={mailAccounts}>
      {children}
    </PaletteHostProvider>
  );
}
