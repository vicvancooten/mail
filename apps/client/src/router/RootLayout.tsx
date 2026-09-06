import type { MailAccount } from "@mail/shared";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Moon, Search, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppSwitcher } from "../apps/AppSwitcher.js";
import { HomeLink } from "../apps/HomeLink.js";
import { Toaster } from "../components/ui/sonner.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { AccountScope } from "../mail/AccountScope.js";
import { isTyping } from "../mail/actions/ActionsProvider.js";
import { useActiveMailHost } from "../mail/actions/active-mail-host.js";
import { noopActionContext } from "../mail/actions/types.js";
import { CommandPalette } from "../mail/command-palette/CommandPalette.js";
import { PaletteHostProvider, usePaletteHost } from "../mail/command-palette/PaletteHostContext.js";
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
 *
 * The Command Palette (#147) is mounted here, once, as a sibling of
 * `.app-viewport` — above Stream and every other App and screen, the same
 * "Client chrome, present on every screen" reasoning `CONTEXT.md`'s Hub
 * entry already gives Account Scope. `PaletteHostProvider` owns the search
 * session and the open/closed flag; `RootLayoutChrome` (below) is what
 * actually reads them, since a provider's own value can't be read by the
 * component that renders it.
 */
export function RootLayout() {
  const mailAccounts = useMailAccounts() ?? [];
  const { scope: accountScope } = useAccountScope(mailAccounts);
  return (
    <PaletteHostProvider accountScope={accountScope} mailAccounts={mailAccounts}>
      <RootLayoutChrome mailAccounts={mailAccounts} />
    </PaletteHostProvider>
  );
}

function RootLayoutChrome({ mailAccounts }: { mailAccounts: MailAccount[] }) {
  const { user, onLogout } = rootRoute.useRouteContext();
  const [signingOut, setSigningOut] = useState(false);
  // Account Scope (#96): moved into the Hub, so it needs the same
  // `mailAccounts`/`useAccountScope` pair `MailSection.tsx` reads — the two
  // stay in sync through `device-preferences.ts#subscribeAccountScope`
  // (`useAccountScope.ts`'s own doc comment), not through a shared prop.
  const { scope: accountScope, setScope: setAccountScope } = useAccountScope(mailAccounts);
  // `Link`'s own `data-status="active"` would do this, but only for exact
  // matches — `/mail` should still read as current while a Thread or label
  // is selected within it (`/mail?thread=…`), which `useRouterState` here
  // (matched against the pathname alone) covers directly.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = rootRoute.useNavigate();
  const [resolvedDark, toggleAppearance] = useResolvedAppearance();
  const { search, paletteOpen, openPalette, closePalette } = usePaletteHost();
  // Whichever Mail-family surface (`MailSection`, `stream/StreamStack`) is
  // currently mounted publishes its own live `ActionContext`/`ViewOrigin`
  // here (`actions/active-mail-host.ts`) — `null` on `/settings` or a
  // placeholder App, where `noopActionContext` (already what the Shortcut
  // Sheet renders against with nothing selected) and "seeds nothing" stand
  // in.
  const activeHost = useActiveMailHost();

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

  // `/`, ⌘K and the Hub's own search pill all raise the Palette directly now
  // (#147) — there is no Mail-scoped mount to navigate to first, since the
  // Palette lives here. `isTyping` (`ActionsProvider.tsx`'s own guard) keeps
  // a bare `/` out of any other field's way; a modified ⌘K still fires while
  // typing, same as every other `meta` binding in the registry.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        openPalette();
        return;
      }
      if (event.key === "/" && !isTyping(event)) {
        event.preventDefault();
        openPalette();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openPalette]);

  function handleLogout() {
    setSigningOut(true);
    void onLogout().finally(() => setSigningOut(false));
  }

  // Selecting a hit or opening the full results view only has somewhere to
  // land on `/mail` (`MailSection`'s own reading pane / `SearchResultsView`)
  // — triggered from anywhere else (Stream, Settings, a placeholder App),
  // navigate there first so "See all results" and Enter still reach the
  // same results view the spec has always described, rather than quietly
  // doing nothing. `CommandPalette.tsx` itself is unchanged (#147: "leave
  // the Palette's content as close to unchanged as you can") — only these
  // two callbacks are wrapped, and only when Mail's own results view isn't
  // already what's on screen.
  const paletteSearch = useMemo(() => {
    if (pathname === "/mail") return search;
    return {
      ...search,
      select: (id: string | null) => {
        void navigate({ to: "/mail" });
        search.select(id);
      },
      openResultsView: () => {
        void navigate({ to: "/mail" });
        search.openResultsView();
      },
    };
  }, [search, pathname, navigate]);

  // Nothing Mail-scoped mounted (Settings, a placeholder App): the same
  // "nothing wired" context the Shortcut Sheet already renders against,
  // with `/`/⌘K's own callbacks still live so those two rows work from
  // anywhere, and Stream still one command away.
  const fallbackCtx = useMemo(
    () =>
      noopActionContext({
        onFocusSearch: openPalette,
        onOpenPalette: openPalette,
        onOpenStream: () => void navigate({ to: "/mail/stream" }),
      }),
    [openPalette, navigate],
  );

  return (
    <TooltipProvider>
      <div className="app-shell">
        <header className="app-header">
          <div className="header-left">
            <HomeLink />
            <AppSwitcher pathname={pathname} />
          </div>
          <div className="header-center">
            <button type="button" className="global-search" onClick={openPalette}>
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
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        ctx={activeHost?.ctx ?? fallbackCtx}
        search={paletteSearch}
        searchOrigin={activeHost?.searchOrigin ?? { kind: "other" }}
        accounts={mailAccounts}
        accountScope={accountScope}
      />
    </TooltipProvider>
  );
}
