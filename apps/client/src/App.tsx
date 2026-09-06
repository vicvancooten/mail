import type { RouterHistory } from "@tanstack/react-router";
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
//
// `history` is an optional pass-through to `router/routes.js#createAppRouter`
// (its own "test seam" doc comment) — production never sets it and gets the
// real browser history; a test can render `<App history={createMemoryHistory()} />`
// to drive the whole routed tree without touching jsdom's shared `window.history`.
function App({ history }: { history?: RouterHistory } = {}) {
  return (
    <AuthProvider>
      <UpdateBanner />
      <main className="app-frame">
        <AuthGate history={history} />
      </main>
    </AuthProvider>
  );
}

export default App;
