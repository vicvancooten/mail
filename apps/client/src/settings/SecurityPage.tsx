import { AuthMethodsSection } from "../auth/AuthMethodsSection.js";

/** Settings' Security page (#99): just `AuthMethodsSection` (#32, passkeys + TOTP), given its own page. */
export function SecurityPage() {
  return (
    <section className="settings-page">
      <h2>Security</h2>
      <AuthMethodsSection />
    </section>
  );
}
