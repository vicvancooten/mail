import type { User } from "@mail/shared";
import { useState } from "react";
import { MailSection } from "../mail/MailSection.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { useAuth } from "./AuthContext.js";

/**
 * The authenticated shell: session controls plus the real triage UI
 * (`MailSection`, #40) and the settings screen below it (#54: Preferences,
 * auth methods, and Mail Account management, all in one place now).
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
      <SettingsSection />
    </div>
  );
}
