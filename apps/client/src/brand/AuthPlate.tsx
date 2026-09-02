import type { ReactNode } from "react";
import { Mark } from "./Mark.js";

/**
 * The pre-session surface: one enamel plate set on the frame, the way a
 * station sign is one plate on a wall. Claim, login and the TOTP challenge
 * all sit in it, so the first thing anyone sees of an instance is the same
 * object regardless of which of the three they land on.
 *
 * Carries the app's only `<h1>` while signed out; `AppShell` carries it
 * afterwards. The line under the mark says what the instance *is*, because
 * this screen is the first evidence a stranger has that the thing on the
 * other side is maintained software.
 */
export function AuthPlate({ children }: { children: ReactNode }) {
  return (
    <div className="auth-frame">
      <div className="auth-plate">
        <header className="auth-plate-head">
          <h1 className="wordmark">
            <Mark size={30} />
            <span className="wordmark-name">Wicket</span>
          </h1>
          <p className="auth-plate-strap">Self-hosted mail, with a door on it</p>
        </header>
        <div className="auth-plate-body">{children}</div>
      </div>
    </div>
  );
}
