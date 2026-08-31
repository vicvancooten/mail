import { useState } from "react";
import { PasskeysSection } from "./PasskeysSection.js";
import { TotpSection } from "./TotpSection.js";

/**
 * Minimal auth-methods management (#32) — TOTP and passkeys beside the
 * password every User already has. Collapsed by default and behind
 * `<details>` so its sections mount (and fetch) only once opened, not on
 * every load of the authenticated shell. A full settings screen is the
 * Preferences ticket.
 */
export function AuthMethodsSection() {
  const [open, setOpen] = useState(false);

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Sign-in methods</summary>
      {open && (
        <>
          <TotpSection />
          <PasskeysSection />
        </>
      )}
    </details>
  );
}
