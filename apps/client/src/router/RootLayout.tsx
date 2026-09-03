import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppSwitcher } from "../apps/AppSwitcher.js";
import { requestGlobalPaletteOpen } from "../mail/command-palette/global-open.js";
import { scrollToMailAccountSettings } from "../mail-accounts/MailAccountsSection.js";
import { subscribeNotificationTarget } from "../pwa/notification-router.js";
import { AvatarMenu } from "./AvatarMenu.js";
import { rootRoute } from "./routes.js";
import "./shell.css";

/**
 * The viewport-owning shell (#71): the header rail plus whichever route is
 * current, in a bounded `.app-viewport` pane. `mail.css`'s `.app-shell` is
 * `100dvh` with `overflow: hidden` and nothing here fights that — every
 * routed screen (`MailRoute`, `SettingsRoute`, the App placeholders) is
 * itself a `height: 100%; min-height: 0` pane that scrolls on its own, so
 * the document never does, at any width (the two reported phone bugs: a
 * bounded-height ancestor missing under the virtualized Thread list, and
 * Settings unreachable below the fold).
 *
 * `user`/`onLogout` ride the router's own context (`routes.ts#RouterContext`)
 * rather than a prop, since this component is instantiated by the router
 * itself, not by a caller who has them to hand.
 */
export function RootLayout() {
  const { user, onLogout } = rootRoute.useRouteContext();
  const [signingOut, setSigningOut] = useState(false);
  // `Link`'s own `data-status="active"` would do this, but only for exact
  // matches — `/mail` should still read as current while a Thread or label
  // is selected within it (`/mail?thread=…`), which `useRouterState` here
  // (matched against the pathname alone) covers directly.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = rootRoute.useNavigate();

  // A `needs-reauth` notification click (#53, ADR-0015: "a click always
  // lands where the next decision is") names a Mail Account's *Settings* —
  // a route now (#71), unlike `thread`/`failed-send`, which stay inside
  // Mail and are handled in `mail/MailSection.tsx` instead. Lives here,
  // not there, because this is what's mounted regardless of which route is
  // current when the click arrives.
  useEffect(() => {
    return subscribeNotificationTarget((target) => {
      if (target.kind !== "needs-reauth") return;
      void navigate({ to: "/settings" }).then(() =>
        scrollToMailAccountSettings(target.mailAccountId),
      );
    });
  }, [navigate]);

  function handleLogout() {
    setSigningOut(true);
    void onLogout().finally(() => setSigningOut(false));
  }

  return (
    <div className="app-shell">
      <header className="shell-rail">
        <AppSwitcher pathname={pathname} />
        <span className="shell-rail-spacer" />
        <p className="shell-user">
          Signed in as <strong>{user.username}</strong>
          {user.role === "owner" ? <span className="shell-role">Owner</span> : null}
        </p>
        <AvatarMenu username={user.username} onLogout={handleLogout} signingOut={signingOut} />
      </header>
      <div className="app-viewport">
        <Outlet />
      </div>
    </div>
  );
}
