import { AuthProvider } from "./auth/AuthContext.js";
import { AuthGate } from "./auth/AuthGate.js";
import { UpdateBanner } from "./pwa/UpdateBanner.js";

// First-run claim, login, and the authenticated shell (#31); the real
// triage UI it hosts (`AppShell` -> `MailSection`) is #40 and on. The
// reload-prompt banner (#44) sits above both — a stale-bundle warning is
// as relevant on the login screen as it is mid-triage.
//
// The `<h1>` lives inside `AuthGate`'s branches rather than here: signed
// out it belongs to the pre-session card (`auth/AuthCard.tsx`), signed in
// it belongs to the header rail (`auth/AppShell.tsx`), and there is exactly
// one of it either way.
function App() {
  return (
    <AuthProvider>
      <UpdateBanner />
      <main className="app-frame">
        <AuthGate />
      </main>
    </AuthProvider>
  );
}

export default App;
