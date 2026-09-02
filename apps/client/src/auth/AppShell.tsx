import type { User } from "@mail/shared";
import { useState } from "react";
import { Mark } from "../brand/Mark.js";
import { Pictogram } from "../brand/Pictogram.js";
import { MailSection } from "../mail/MailSection.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { useAuth } from "./AuthContext.js";

/**
 * The authenticated shell: session controls plus the real triage UI
 * (`MailSection`, #40) and the settings screen below it (#54: Preferences,
 * auth methods, and Mail Account management, all in one place now).
 *
 * Deliberately still one stacked column rather than a routed two-pane app —
 * there is no router in this Client (`settings/SettingsSection.tsx` says
 * why), so settings is the compartment below the mail frame, not a
 * destination. The header rail is the app's governing left axis: the mark
 * and the signed-in User register to it, and every surface underneath lines
 * up on the same edge.
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
    <div className="app-shell">
      <header className="shell-rail">
        <h1 className="wordmark">
          <Mark size={22} />
          <span className="wordmark-name">Wicket</span>
        </h1>
        <span className="shell-rail-spacer" />
        <p className="shell-user">
          Signed in as <strong>{user.username}</strong>
          {user.role === "owner" ? <span className="shell-role">Owner</span> : null}
        </p>
        <button
          type="button"
          className="shell-signout"
          onClick={handleLogout}
          disabled={signingOut}
        >
          <Pictogram name="close" size={13} />
          {signingOut ? "Logging out…" : "Log out"}
        </button>
      </header>
      <div className="shell-mail">
        <MailSection />
      </div>
      <SettingsSection />
    </div>
  );
}
