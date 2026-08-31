import { AppShell } from "./AppShell.js";
import { useAuth } from "./AuthContext.js";
import { ClaimForm } from "./ClaimForm.js";
import { LoginForm } from "./LoginForm.js";
import { TotpChallengeForm } from "./TotpChallengeForm.js";

/** Renders the right one of first-run claim / login / TOTP challenge / authenticated shell off `AuthContext`. */
export function AuthGate() {
  const { state } = useAuth();

  switch (state.kind) {
    case "loading":
      return <p>Loading…</p>;
    case "unclaimed":
      return <ClaimForm />;
    case "login-required":
      return <LoginForm />;
    case "totp-required":
      return <TotpChallengeForm />;
    case "authenticated":
      return <AppShell user={state.user} />;
  }
}
