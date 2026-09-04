import type { User } from "@mail/shared";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createAppRouter } from "../router/routes.js";
import { useAuth } from "./AuthContext.js";

/**
 * The authenticated shell (#31, and #71's router): builds the app's one
 * `Router` — seeded with the signed-in `User` and the sign-out handler
 * every route's header rail needs (`router/routes.ts#RouterContext`) — and
 * hands it to `RouterProvider`. `router/RootLayout.tsx` is what actually
 * renders the header rail and the routed `MailSection`/`SettingsLayout`/
 * placeholder-App views underneath it.
 *
 * `useState(() => …)` rather than a plain `useMemo`/module-scope constant:
 * a Router is a stateful object (it owns its own subscriptions to
 * `history`), so it needs to survive this component's own re-renders
 * without being rebuilt, but it also has to be a *fresh* one each time a
 * `User` signs back in — `AuthGate` unmounts this component entirely on
 * logout, which is what makes "fresh" free here rather than something this
 * component has to arrange itself.
 */
export function AppShell({ user }: { user: User }) {
  const { logout } = useAuth();
  const [router] = useState(() => createAppRouter({ user, onLogout: logout }));
  // The router itself is built once (above); a `User` object that changes
  // identity mid-session (a fresh `/auth/session` read) still has to reach
  // every route's `rootRoute.useRouteContext()` — `router.update` is
  // TanStack Router's own seam for that, not a rebuild.
  useEffect(() => {
    router.update({ context: { user, onLogout: logout } });
  }, [router, user, logout]);

  return <RouterProvider router={router} />;
}
