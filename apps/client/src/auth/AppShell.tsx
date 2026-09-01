import type { User } from "@mail/shared";
import { useState } from "react";
import { MailSection } from "../mail/MailSection.js";
import { MailAccountsSection } from "../mail-accounts/MailAccountsSection.js";
import { useAuth } from "./AuthContext.js";
import { AuthMethodsSection } from "./AuthMethodsSection.js";

/**
 * The authenticated shell: session controls plus the real triage UI
 * (`MailSection`, #40) and the account/auth settings sections below it.
 */
export function AppShell({ user }: { user: User }) {
  const { logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div>
      <p>
        Signed in as <strong>{user.username}</strong>
        {user.role === "owner" ? " (Owner)" : null}.
      </p>
      <button type="button" onClick={handleLogout} disabled={signingOut}>
        Log out
      </button>
      <MailSection />
      <AuthMethodsSection />
      <MailAccountsSection />
    </div>
  );
}
