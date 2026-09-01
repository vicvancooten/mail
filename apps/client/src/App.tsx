import { AuthProvider } from "./auth/AuthContext.js";
import { AuthGate } from "./auth/AuthGate.js";

// First-run claim, login, and the authenticated shell (#31); the real
// triage UI it hosts (`AppShell` -> `MailSection`) is #40 and on.
function App() {
  return (
    <AuthProvider>
      <main>
        <h1>Mail</h1>
        <AuthGate />
      </main>
    </AuthProvider>
  );
}

export default App;
