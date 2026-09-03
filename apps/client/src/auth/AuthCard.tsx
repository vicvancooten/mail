import type { ReactNode } from "react";
import { Mark } from "../brand/Mark.js";

/**
 * The pre-session surface, on The Instrument (#83): one bounded card set on
 * the page ground, the way every overlay in this system reads — a hairline
 * border and a corner radius, never a shadow or a plate. Claim, login and
 * the TOTP challenge all sit in it, so the first thing anyone sees of an
 * instance is the same object regardless of which of the three they land
 * on. Replaces the enamel `AuthPlate` from the prior identity, deleted
 * along with the rest of that system in this ticket.
 *
 * Carries the app's only `<h1>` while signed out; `RootLayout` carries it
 * afterwards. The line under the mark says what the instance *is*, because
 * this screen is the first evidence a stranger has that the thing on the
 * other side is maintained software.
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-background px-5 py-8"
      style={{
        paddingTop: "calc(2rem + env(safe-area-inset-top))",
        paddingBottom: "calc(3rem + env(safe-area-inset-bottom))",
      }}
    >
      <div className="w-full max-w-[420px] rounded-[var(--radius-md)] border border-border bg-card">
        <header className="rounded-t-[var(--radius-md)] border-b border-border bg-muted px-6 py-5">
          <h1 className="m-0 flex items-center gap-2 text-foreground">
            <Mark size={28} />
            <span className="text-[21px] font-extrabold tracking-tight uppercase">Wicket</span>
          </h1>
          <p className="mt-2 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Self-hosted mail, with a door on it
          </p>
        </header>
        <div className="px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
