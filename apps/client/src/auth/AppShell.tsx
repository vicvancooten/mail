import type { User } from "@mail/shared";
import { useState } from "react";
import { useAuth } from "./AuthContext.js";

/**
 * The authenticated shell. Real triage UI lands on top of this per the
 * `prototype/triage-loop-ui` branch (#40); for now it's the logged-in
 * placeholder that proves the session round-trip end to end.
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
    </div>
  );
}
