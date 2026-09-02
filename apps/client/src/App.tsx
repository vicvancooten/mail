import { AuthProvider } from "./auth/AuthContext.js";
import { AuthGate } from "./auth/AuthGate.js";
import { UpdateBanner } from "./pwa/UpdateBanner.js";

// First-run claim, login, and the authenticated shell (#31); the real
// triage UI it hosts (`AppShell` -> `MailSection`) is #40 and on. The
// reload-prompt banner (#44) sits above both — a stale-bundle warning is
// as relevant on the login screen as it is mid-triage.
function App() {
  return (
    <AuthProvider>
      <UpdateBanner />
      <main>
        <h1>Mail</h1>
        <AuthGate />
      </main>
    </AuthProvider>
  );
}

export default App;
