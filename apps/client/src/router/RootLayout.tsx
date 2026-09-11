import type { MailAccount } from "@mail/shared";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Moon, Search, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSwitcher } from "../apps/AppSwitcher.js";
import { accountScopeFacetForApp, appForPath } from "../apps/apps.js";
import { HomeLink } from "../apps/HomeLink.js";
import { CalendarReminderToast } from "../calendar/CalendarReminderToast.js";
import { CalendarRollbackToast } from "../calendar/CalendarRollbackToast.js";
import { Toaster } from "../components/ui/sonner.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { useIsPhoneWidth } from "../hooks/use-phone-width.js";
import { AccountScope } from "../mail/AccountScope.js";
import { isTyping } from "../mail/actions/ActionsProvider.js";
import { useActiveMailHost } from "../mail/actions/active-mail-host.js";
import { noopActionContext } from "../mail/actions/types.js";
import { CommandPalette } from "../mail/command-palette/CommandPalette.js";
import { PaletteHostProvider, usePaletteHost } from "../mail/command-palette/PaletteHostContext.js";
import { deriveMailAccountScope, useAccountScope } from "../mail/useAccountScope.js";
import { subscribeNotificationTarget } from "../pwa/notification-router.js";
import { useConnectedAccounts, useMailAccounts } from "../store/index.js";
import { useResolvedAppearance } from "../theme/device-theme.js";
import { AvatarMenu } from "./AvatarMenu.js";
import { BottomBar } from "./BottomBar.js";
import { rootRoute } from "./routes.js";
import { useChromeRetract } from "./useChromeRetract.js";
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
 * home mark (`HomeLink.tsx`, a plain `Link` to `/mail` on desktop) and, as
 * its own adjacent control, the App Switcher; centre the global search entry;
 * right is Account Scope (`AccountScope.tsx`, moved here from
 * `mail/TopBar.tsx` — Client chrome per `CONTEXT.md`'s own Hub entry), the
 * appearance toggle, and the User's avatar menu. Nothing here names the
 * signed-in User in prose any more — the avatar and its menu carry that,
 * the way the comp does.
 *
 * Account Scope is a per-App question (#187, `apps/apps.ts#AppDef.observesAccountScope`):
 * Mail, Calendar and Contacts read a Connected Account's data, so narrowing
 * means something on them; Tasks and Notes belong to the User alone, so the
 * Hub hides the control there rather than rendering it disabled or empty
 * over nothing to narrow. Hiding it never touches `accountScope` itself —
 * the hook's own state (and the Device Preference it rides,
 * `useAccountScope.ts`) lives independently of which App is current, so the
 * User's last Scope is exactly what's still selected on returning to an App
 * that observes it. The rendered App's own Facet (`apps.ts#accountScopeFacetForApp`,
 * #207) is what the picker mutes rows against — Mail open mutes a
 * Calendar-only Connected Account's row, Calendar open would mute a
 * Mail-only one's.
 *
 * The App itself renders inside `.app-card` (#96): a raised card on the
 * Hub's own ground at ≥768px (`shell.css`'s own breakpoint, the app's one
 * phone breakpoint, #273) and full-bleed on the phone —
 * `.app-viewport`'s padding and `.app-card`'s radius/shadow both toggle at
 * that width, rather than either route rendering two different trees.
 *
 * Phone chrome (#155, rescinding `DESIGN.md`'s earlier "no bottom tab bar"
 * for phone): the header's own `AppSwitcher` instance and the appearance
 * toggle drop out of the header on phone — a real conditional
 * (`isPhoneChrome` below), not CSS-only visibility, since a hidden-but-
 * mounted "Switch app" control is a duplicate accessible control, not a
 * neutral simplification. `BottomBar.tsx` picks up Folders, the App
 * Switcher and Compose down there instead, and Appearance folds into
 * `AvatarMenu`'s own radio group, which already had it. `HomeLink` itself
 * stays (#286, `CONTEXT.md`'s own Hub entry: "on a phone the Hub keeps the
 * top bar full-width and full-bleed, the home mark at its leading edge, and
 * hands the App Switcher to the Dock") — its `to` just narrows from `/mail`
 * to `currentApp`'s own root, since there's no adjacent Switcher on phone to
 * jump elsewhere with. The header and the bottom bar retract together on
 * scroll-down and return on scroll-up (`useChromeRetract.ts`),
 * `data-chrome-hidden` below being what `shell.css`'s phone query reads to
 * animate both — the header's own box carries its safe-area inset as
 * padding on itself, so the same transform moves both together.
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
  // The Palette's own search scope (`PaletteHostContext.tsx`'s own doc
  // comment) is Mail-Account-scoped, not Connected-Account-scoped (#207) —
  // the same `deriveMailAccountScope` translation `MailSection.tsx` and
  // `RootLayoutChrome` below both do from the Hub's own Connected Account
  // Scope, computed independently here since the Palette mounts one level
  // above the header that owns the picker.
  const connectedAccounts = useConnectedAccounts() ?? [];
  const { scope: connectedAccountScope } = useAccountScope(connectedAccounts);
  const accountScope = deriveMailAccountScope(
    connectedAccounts,
    connectedAccountScope,
    mailAccounts,
  );
  return (
    <PaletteHostProvider accountScope={accountScope} mailAccounts={mailAccounts}>
      <RootLayoutChrome mailAccounts={mailAccounts} />
    </PaletteHostProvider>
  );
}

function RootLayoutChrome({ mailAccounts }: { mailAccounts: MailAccount[] }) {
  const { user, onLogout } = rootRoute.useRouteContext();
  const [signingOut, setSigningOut] = useState(false);
  // Account Scope (#96, repointed at Connected Accounts in #207): moved into
  // the Hub, so it needs the same `connectedAccounts`/`useAccountScope` pair
  // `MailSection.tsx` reads (via `useAccountScope.ts#deriveMailAccountScope`)
  // — the two stay in sync through `device-preferences.ts#subscribeAccountScope`
  // (`useAccountScope.ts`'s own doc comment), not through a shared prop.
  const connectedAccounts = useConnectedAccounts() ?? [];
  const { scope: accountScope, setScope: setAccountScope } = useAccountScope(connectedAccounts);
  // `Link`'s own `data-status="active"` would do this, but only for exact
  // matches — `/mail` should still read as current while a Thread or label
  // is selected within it (`/mail?thread=…`), which `useRouterState` here
  // (matched against the pathname alone) covers directly.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentApp = appForPath(pathname);
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
  // lands where the next decision is") names a Facet's *Settings* cell — a
  // route now (#71), unlike `thread`/`failed-send`, which stay inside Mail
  // and are handled in `mail/MailSection.tsx` instead. Lives here, not
  // there, because this is what's mounted regardless of which route is
  // current when the click arrives. Lands on `/settings/connected-accounts`
  // (#201, `/settings/mail-accounts`'s new address) carrying the target
  // Connected Account's id and Facet in `?account=&facet=` (#204, widened
  // from a Mail-Account-only `?account=`) —
  // `connected-accounts/account-focus.ts`'s own doc comment on why this is a
  // pair of query params now rather than a DOM id to scroll to: a table cell
  // can hold several accounts' Badges, so there is no longer one row per
  // account, and a Calendar/Contacts Facet has no Mail Account id to carry.
  useEffect(() => {
    return subscribeNotificationTarget((target) => {
      if (target.kind !== "needs-reauth") return;
      void navigate({
        to: "/settings/connected-accounts",
        search: { account: target.connectedAccountId, facet: target.facet },
      });
    });
  }, [navigate]);

  // A `calendar-event` click (#246, ADR-0028: "tapping opens the Event in
  // an existing window") — mounted regardless of route, `needs-reauth`'s own
  // sibling above, since a Reminder or Answer notification can arrive while
  // the User is anywhere in the app, not only inside Calendar.
  // `calendarEventRoute`'s own `beforeLoad` (`routes.tsx`) redirects silently
  // back to `/calendar` for an id that resolves to nothing.
  useEffect(() => {
    return subscribeNotificationTarget((target) => {
      if (target.kind !== "calendar-event") return;
      void navigate({ to: "/calendar/$eventKey", params: { eventKey: target.eventId } });
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

  // A Command Palette local hit's own entry point (#196, #262): `to`/`params`
  // come from whichever App's own `LocalHitSource` produced the hit
  // (`mail/command-palette/local-hits.ts`), which knows nothing of the route
  // tree itself. This lives here rather than in whichever Mail-family
  // surface happens to be mounted — unlike `ctx`/`searchOrigin`
  // (`actions/active-mail-host.ts`), a local hit's destination is never
  // Mail-scoped state, just a plain route the Hub's own `navigate` can reach
  // directly, the same "erase the per-collection type once, at the
  // boundary" idiom `sync/collection-registry.ts#asApplyUserDelta` already
  // uses for the sync side of the same ADR-0023 mechanism. A section's own
  // "See all results" row (#262) reuses this with an empty `params` and a
  // `search` instead (`/tasks?q=`), so `search` is only ever spread in where
  // given — an empty object here would otherwise clobber whatever a plain
  // hit's own route already carries.
  const onOpenLocalHit = useCallback(
    (to: string, params: Record<string, string>, search?: Record<string, string>) => {
      void navigate({
        to,
        params,
        ...(search ? { search } : {}),
      } as unknown as Parameters<typeof navigate>[0]);
    },
    [navigate],
  );

  // Nothing Mail-scoped mounted (Settings, a placeholder App): the same
  // "nothing wired" context the Shortcut Sheet already renders against,
  // with `/`/⌘K's own callbacks still live so those two rows work from
  // anywhere, and Stream still one command away. The phone bottom bar's
  // Folders and Compose buttons (#155) read this same fallback — from
  // Settings or a placeholder App, both navigate to Mail first rather than
  // doing nothing, the same "navigate, then act" shape `paletteSearch`
  // above already uses for a hit selected from outside `/mail`.
  const fallbackCtx = useMemo(
    () =>
      noopActionContext({
        onFocusSearch: openPalette,
        onOpenPalette: openPalette,
        onOpenStream: () => void navigate({ to: "/mail/stream" }),
        onOpenFolders: () => void navigate({ to: "/mail" }),
        onCompose: () => void navigate({ to: "/mail" }),
      }),
    [openPalette, navigate],
  );

  // The Hub header and phone bottom bar retract on scroll-down, return on
  // scroll-up (#155's own acceptance box) — `data-chrome-hidden` below is
  // what `shell.css`'s phone query reads; see `useChromeRetract.ts` for why
  // one hook here covers every scrollable pane any route renders.
  const chromeHidden = useChromeRetract(pathname);
  const activeCtx = activeHost?.ctx ?? fallbackCtx;

  // The phone/desktop split for this chrome (#155): a real conditional, not
  // CSS-only visibility — `AppSwitcher.tsx`'s own `useIsPhoneWidth`, the
  // app's one 768px breakpoint (#273 unified this with the Mail/Settings
  // split that used to sit at a different 700px). `AppSwitcher` already
  // branches its own Sheet-vs-inline rendering on this exact hook, and
  // mounting *both* a header instance and a bottom-bar instance of it (each
  // carrying the same "Switch app" accessible name) would be a real
  // duplicate-control bug, not just a test inconvenience — CSS `display:
  // none` hides one visually but leaves it in the accessibility tree and
  // tab order. `shell.css`'s own phone query for this chrome matches this
  // same 768px number for exactly that reason.
  const isPhoneChrome = useIsPhoneWidth();

  return (
    <TooltipProvider>
      <div className="app-shell" data-chrome-hidden={chromeHidden}>
        <header className="app-header">
          <div className="header-left">
            <HomeLink to={isPhoneChrome ? (currentApp?.path ?? "/mail") : "/mail"} />
            {!isPhoneChrome && <AppSwitcher pathname={pathname} />}
          </div>
          <div className="header-center">
            <button type="button" className="global-search" onClick={openPalette}>
              <Search size={16} />
              <span>Search everything…</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
          <div className="header-right">
            {(currentApp?.observesAccountScope ?? true) ? (
              <AccountScope
                accounts={connectedAccounts}
                scope={accountScope}
                activeFacet={accountScopeFacetForApp(currentApp)}
                onChange={setAccountScope}
              />
            ) : null}
            {!isPhoneChrome && (
              <button
                type="button"
                className="header-icon-btn"
                title="Toggle appearance"
                aria-label="Toggle appearance"
                onClick={toggleAppearance}
              >
                {resolvedDark ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            )}
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
        {isPhoneChrome && <BottomBar pathname={pathname} ctx={activeCtx} />}
        <Toaster />
        <CalendarRollbackToast />
        <CalendarReminderToast />
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        ctx={activeCtx}
        search={paletteSearch}
        searchOrigin={activeHost?.searchOrigin ?? { kind: "other" }}
        accounts={mailAccounts}
        accountScope={accountScope}
        onOpenLocalHit={onOpenLocalHit}
      />
    </TooltipProvider>
  );
}
