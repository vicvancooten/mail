import { Outlet, useRouterState } from "@tanstack/react-router";
import { Moon, Search, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { AppSwitcher } from "../apps/AppSwitcher.js";
import { HomeLink } from "../apps/HomeLink.js";
import { Toaster } from "../components/ui/sonner.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { AccountScope } from "../mail/AccountScope.js";
import { requestGlobalPaletteOpen } from "../mail/command-palette/global-open.js";
import { useAccountScope } from "../mail/useAccountScope.js";
import { scrollToMailAccountSettings } from "../mail-accounts/MailAccountsSection.js";
import { subscribeNotificationTarget } from "../pwa/notification-router.js";
import { useMailAccounts } from "../store/index.js";
import { useResolvedAppearance } from "../theme/device-theme.js";
import { AvatarMenu } from "./AvatarMenu.js";
import { rootRoute } from "./routes.js";
import "./shell.css";

/**
 * The viewport-owning shell (#71, rebuilt against the comp in #86): the
 * global header plus whichever route is current, in a bounded
 * `.app-viewport` pane. `.app-shell` is `100dvh` with `overflow: hidden` and
 * nothing here fights that — every routed screen (`MailRoute`,
 * `SettingsRoute`, the App placeholders) is itself a `height: 100%;
 * min-height: 0` pane that scrolls on its own, so the document never does,
 * at any width (the two reported phone bugs: a bounded-height ancestor
 * missing under the virtualized Thread list, and Settings unreachable below
 * the fold).
 *
 * The header is the comp's `.app-header`
 * (`docs/design/prototypes/the-instrument.html`), reshaped by #96's own
 * acceptance box: a three-column grid whose outer columns are equal
 * fractions, so the centred search field is centred on the *viewport*
 * rather than on whatever is left over beside the switcher. Left is the
 * home mark (`HomeLink.tsx`, a plain `Link` to `/mail`) and, as its own
 * adjacent control, the App Switcher; centre the global search entry;
 * right is Account Scope (`AccountScope.tsx`, moved here from
 * `mail/TopBar.tsx` — Client chrome per `CONTEXT.md`'s own Hub entry), the
 * appearance toggle, and the User's avatar menu. Nothing here names the
 * signed-in User in prose any more — the avatar and its menu carry that,
 * the way the comp does.
 *
 * The App itself renders inside `.app-card` (#96): a raised card on the
 * Hub's own ground at ≥701px (`shell.css`'s own breakpoint, matching every
 * other Split/List layout switch in the app) and full-bleed on the phone —
 * `.app-viewport`'s padding and `.app-card`'s radius/shadow both toggle at
 * that width, rather than either route rendering two different trees.
 *
 * `user`/`onLogout` ride the router's own context (`routes.ts#RouterContext`)
 * rather than a prop, since this component is instantiated by the router
 * itself, not by a caller who has them to hand.
 */
export function RootLayout() {
  const { user, onLogout } = rootRoute.useRouteContext();
  const [signingOut, setSigningOut] = useState(false);
  // Account Scope (#96): moved into the Hub, so it needs the same
  // `mailAccounts`/`useAccountScope` pair `MailSection.tsx` reads — the two
  // stay in sync through `device-preferences.ts#subscribeAccountScope`
  // (`useAccountScope.ts`'s own doc comment), not through a shared prop.
  const mailAccounts = useMailAccounts() ?? [];
  const { scope: accountScope, setScope: setAccountScope } = useAccountScope(mailAccounts);
  // `Link`'s own `data-status="active"` would do this, but only for exact
  // matches — `/mail` should still read as current while a Thread or label
  // is selected within it (`/mail?thread=…`), which `useRouterState` here
  // (matched against the pathname alone) covers directly.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = rootRoute.useNavigate();
  const [resolvedDark, toggleAppearance] = useResolvedAppearance();

  // A `needs-reauth` notification click (#53, ADR-0015: "a click always
  // lands where the next decision is") names a Mail Account's *Settings* —
  // a route now (#71), unlike `thread`/`failed-send`, which stay inside
  // Mail and are handled in `mail/MailSection.tsx` instead. Lives here,
  // not there, because this is what's mounted regardless of which route is
  // current when the click arrives. Lands on `/settings/mail-accounts`
  // directly (#99) — that's the one sub-route `MailAccountsSection`, and so
  // the row `scrollToMailAccountSettings` targets, actually renders on.
  useEffect(() => {
    return subscribeNotificationTarget((target) => {
      if (target.kind !== "needs-reauth") return;
      void navigate({ to: "/settings/mail-accounts" }).then(() =>
        scrollToMailAccountSettings(target.mailAccountId),
      );
    });
  }, [navigate]);

  // ⌘K reaches the Command Palette everywhere (the direction contract's
  // signature interaction), but the Palette itself is Mail-scoped
  // (`global-open.ts`'s own doc comment). Outside `/mail`, catch the chord
  // here, record the request, and navigate — `MailSection`'s mount effect
  // consumes the flag and opens the already-built Palette. Inside `/mail`,
  // `MailSection` owns `⌘K` directly, so this only needs to act when it's
  // the one thing mounted.
  useEffect(() => {
    if (pathname.startsWith("/mail")) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      requestGlobalPaletteOpen();
      void navigate({ to: "/mail" });
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pathname, navigate]);

  function handleLogout() {
    setSigningOut(true);
    void onLogout().finally(() => setSigningOut(false));
  }

  // The header field is the comp's search *entry* — a button that raises the
  // Command Palette, not a second text input beside Mail's own. Off `/mail`
  // the request rides the same bridge `⌘K` does, navigating so there is a
  // Palette to open; on `/mail` a mounted `MailSection` takes it directly
  // (`global-open.ts`).
  function openGlobalSearch() {
    requestGlobalPaletteOpen();
    if (!pathname.startsWith("/mail")) void navigate({ to: "/mail" });
  }

  return (
    <TooltipProvider>
      <div className="app-shell">
        <header className="app-header">
          <div className="header-left">
            <HomeLink />
            <AppSwitcher pathname={pathname} />
          </div>
          <div className="header-center">
            <button type="button" className="global-search" onClick={openGlobalSearch}>
              <Search size={16} />
              <span>Search everything…</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
          <div className="header-right">
            <AccountScope accounts={mailAccounts} scope={accountScope} onChange={setAccountScope} />
            <button
              type="button"
              className="header-icon-btn"
              title="Toggle appearance"
              aria-label="Toggle appearance"
              onClick={toggleAppearance}
            >
              {resolvedDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <AvatarMenu
              username={user.username}
              role={user.role}
              onLogout={handleLogout}
              signingOut={signingOut}
            />
          </div>
        </header>
        <div className="app-viewport">
          <div className="app-card">
            <Outlet />
          </div>
        </div>
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
