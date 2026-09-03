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
import { SettingsSection } from "../settings/SettingsSection.js";
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
 * build-time route generation set up, and six routes is small enough that
 * hand-written `createRoute` calls stay more legible than adding a plugin
 * for it.
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

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsSection,
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
  settingsRoute,
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
