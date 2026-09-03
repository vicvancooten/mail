import { Mark } from "../brand/Mark.js";
import { AppShell } from "./AppShell.js";
import { AuthCard } from "./AuthCard.js";
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
        <div className="flex min-h-dvh items-center justify-center bg-background" aria-busy="true">
          <p className="m-0 flex items-center gap-2.5 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            <Mark size={26} className="text-primary" />
            <span>Opening the frame…</span>
          </p>
        </div>
      );
    case "unclaimed":
      return (
        <AuthCard>
          <ClaimForm />
        </AuthCard>
      );
    case "login-required":
      return (
        <AuthCard>
          <LoginForm />
        </AuthCard>
      );
    case "totp-required":
      return (
        <AuthCard>
          <TotpChallengeForm />
        </AuthCard>
      );
    case "authenticated":
      return <AppShell user={state.user} />;
  }
}
