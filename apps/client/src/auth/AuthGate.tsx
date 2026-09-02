import { AuthPlate } from "../brand/AuthPlate.js";
import { Mark } from "../brand/Mark.js";
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
      // No spinner: the mark itself is the wait. Session resume is a single
      // same-origin request, so anything more elaborate would be on screen
      // for less time than it took to draw.
      return (
        <div className="auth-frame" aria-busy="true">
          <p className="auth-waiting">
            <Mark size={26} />
            <span>Opening the frame…</span>
          </p>
        </div>
      );
    case "unclaimed":
      return (
        <AuthPlate>
          <ClaimForm />
        </AuthPlate>
      );
    case "login-required":
      return (
        <AuthPlate>
          <LoginForm />
        </AuthPlate>
      );
    case "totp-required":
      return (
        <AuthPlate>
          <TotpChallengeForm />
        </AuthPlate>
      );
    case "authenticated":
      return <AppShell user={state.user} />;
  }
}
