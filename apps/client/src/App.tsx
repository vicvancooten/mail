import { AuthProvider } from "./auth/AuthContext.js";
import { AuthGate } from "./auth/AuthGate.js";

// The real triage UI lives on `prototype/triage-loop-ui` and lands here once
// that ticket's direction is merged in; this is first-run claim, login, and
// the authenticated shell (#31).
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
