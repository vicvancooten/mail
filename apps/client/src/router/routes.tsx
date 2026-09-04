import type { User } from "@mail/shared";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { APPS_BY_KEY } from "../apps/apps.js";
import { PlaceholderRoute } from "../apps/PlaceholderRoute.js";
import { type FolderKey, parseFolderKey } from "../mail/folders.js";
import { GatekeeperPage } from "../settings/GatekeeperPage.js";
import { GeneralSection } from "../settings/GeneralSection.js";
import { MailAccountsPage } from "../settings/MailAccountsPage.js";
import { NotificationsPage } from "../settings/NotificationsPage.js";
import { SecurityPage } from "../settings/SecurityPage.js";
import { SettingsLayout } from "../settings/SettingsLayout.js";
import { ThisDeviceSection } from "../settings/ThisDeviceSection.js";
import { MailRoute } from "./MailRoute.js";
import { RootLayout } from "./RootLayout.js";

/**
 * TanStack Router replaces the routerless view state (#71, part of #66): a
 * router and a viewport-owning shell, with real URLs for Mail (a folder,
 * plus a selected Thread), the three placeholder Apps, and Settings — a
 * routed view now rather than a compartment scrolled to below the mail
 * pane. Search deliberately gets none of this (ADR-0017): see
 * `mail/search/useSearchOverlay.ts`.
 *
 * Code-based routes rather than file-based + codegen: this Client has no
 * build-time route generation set up, and this many routes is still small
 * enough that hand-written `createRoute` calls stay more legible than
 * adding a plugin for it.
 *
 * Settings is a layout route with its own sub-routes now (#99), the same
 * shape `mailRoute` already gives Mail's own folder/label state — General,
 * This device, Mail Accounts, Gatekeeper, Notifications and Security each
 * get a real URL under `/settings`, with a side nav (`SettingsLayout`)
 * rather than one long-scrolling page.
 */

/** Carried by every route via `rootRoute.useRouteContext()` — the signed-in User `RootLayout`'s header rail renders, and the sign-out handler it wires to a button. Built once, in `auth/AppShell.tsx`, from `AuthContext`. */
export interface RouterContext {
  user: User;
  onLogout: () => Promise<void>;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

/** `/` itself is never a screen — it only ever forwards to Mail, the app's default. */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/mail" });
  },
});

export interface MailSearch {
  /** A Label id — `MailSection`'s own `labelFilter`; unset is the ordinary Inbox. */
  label?: string;
  /**
   * The sidebar folder destination (#74, `mail/folders.ts#FolderKey`) —
   * `MailSection`'s own `folder`. Unset defaults to `DEFAULT_FOLDER`
   * (Inbox), the same way an unset `label` does; an unrecognized value (an
   * old bookmark, hand-edited URL) falls back to it too rather than handing
   * `MailSection` a folder it doesn't know.
   */
  folder?: FolderKey;
  /** The selected Thread id. */
  thread?: string;
}

export const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail",
  validateSearch: (search: Record<string, unknown>): MailSearch => ({
    label: typeof search.label === "string" ? search.label : undefined,
    folder:
      parseFolderKey(typeof search.folder === "string" ? search.folder : undefined) ?? undefined,
    thread: typeof search.thread === "string" ? search.thread : undefined,
  }),
  component: MailRoute,
});

/**
 * Settings' own sub-routes (#99): `settingsRoute` is now a layout route
 * (`SettingsLayout`'s side nav + `<Outlet/>`) rather than a single screen —
 * `/settings` itself carries no content of its own, redirecting to General
 * the same way `indexRoute` above forwards `/` to Mail. Each child is its
 * own bounded pane (`SettingsLayout`'s own doc comment).
 */
export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsLayout,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/general" });
  },
});

export const settingsGeneralRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/general",
  component: GeneralSection,
});

export const settingsThisDeviceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/this-device",
  component: ThisDeviceSection,
});

export const settingsMailAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/mail-accounts",
  component: MailAccountsPage,
});

export const settingsGatekeeperRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/gatekeeper",
  component: GatekeeperPage,
});

export const settingsNotificationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/notifications",
  component: NotificationsPage,
});

export const settingsSecurityRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/security",
  component: SecurityPage,
});

export const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: () => <PlaceholderRoute app={APPS_BY_KEY.contacts} />,
});

export const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/calendar",
  component: () => <PlaceholderRoute app={APPS_BY_KEY.calendar} />,
});

export const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  component: () => <PlaceholderRoute app={APPS_BY_KEY.tasks} />,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  mailRoute,
  settingsRoute.addChildren([
    settingsIndexRoute,
    settingsGeneralRoute,
    settingsThisDeviceRoute,
    settingsMailAccountsRoute,
    settingsGatekeeperRoute,
    settingsNotificationsRoute,
    settingsSecurityRoute,
  ]),
  contactsRoute,
  calendarRoute,
  tasksRoute,
]);

/**
 * `history` is the test seam: production leaves it unset and gets the
 * default browser history; a test passes a `createMemoryHistory()` so it
 * can boot straight at a chosen URL without one test's navigation leaking
 * into the next via the real, jsdom-shared `window.history`.
 */
export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, ...(history ? { history } : {}) });
}
