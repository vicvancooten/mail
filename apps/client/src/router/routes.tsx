import type { User } from "@mail/shared";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { CalendarRoute } from "../calendar/CalendarRoute.js";
import { validateCalendarSearch } from "../calendar/calendar-url.js";
import { ContactsRecentlyDeleted } from "../contacts/ContactsRecentlyDeleted.js";
import { isPhoneWidth } from "../hooks/use-phone-width.js";
import { type FolderKey, parseFolderKey } from "../mail/folders.js";
import { NotesRecentlyDeleted } from "../notes/NotesRecentlyDeleted.js";
import { ConnectedAccountsPage } from "../settings/ConnectedAccountsPage.js";
import { GatekeeperPage } from "../settings/GatekeeperPage.js";
import { GeneralSection } from "../settings/GeneralSection.js";
import { InstancePage } from "../settings/InstancePage.js";
import { NotificationsPage } from "../settings/NotificationsPage.js";
import { SecurityPage } from "../settings/SecurityPage.js";
import { SettingsLayout } from "../settings/SettingsLayout.js";
import { ThisDeviceSection } from "../settings/ThisDeviceSection.js";
import { contactExists } from "../store/contacts.js";
import { eventExists } from "../store/events.js";
import { ensureLocalCacheOpen, noteExists, taskExists } from "../store/index.js";
import { TasksRecentlyDeleted } from "../tasks/TasksRecentlyDeleted.js";
import { CalendarEventRoute } from "./CalendarEventRoute.js";
import { ContactDialogRoute } from "./ContactDialogRoute.js";
import { ContactsRoute } from "./ContactsRoute.js";
import { MailRoute } from "./MailRoute.js";
import { NewContactRoute } from "./NewContactRoute.js";
import { NoteDialogRoute } from "./NoteDialogRoute.js";
import { NotesRoute } from "./NotesRoute.js";
import { ReaderRoute } from "./ReaderRoute.js";
import { RootLayout } from "./RootLayout.js";
import { StreamRoute } from "./StreamRoute.js";
import { TasksIndexRoute, TasksTaskRoute } from "./TasksRoute.js";

/**
 * TanStack Router replaces the routerless view state (#71, part of #66): a
 * router and a viewport-owning shell, with real URLs for Mail (a folder,
 * plus a selected Thread), the two remaining placeholder Apps, Notes,
 * Tasks (#252) and Settings — a routed view now rather than a compartment
 * scrolled to below the mail pane. Search deliberately gets none of this
 * (ADR-0017): see `mail/search/useSearchOverlay.ts`.
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
  /**
   * A notification deep-link's Mail Account (#151), *not* part of the
   * restorable snapshot `onLocationChange` mirrors back: Account Scope is
   * its own Device Preference (`useAccountScope.ts`), so this only ever
   * seeds `MailSection`'s `initialAccountId` on a fresh mount — widening a
   * previously-narrowed Scope so the `thread`/`screener` target above is
   * actually visible. `MailRoute`'s own `onLocationChange` never writes it
   * back, so it drops out of the URL the instant the mount settles.
   */
  account?: string;
}

export const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail",
  validateSearch: (search: Record<string, unknown>): MailSearch => ({
    label: typeof search.label === "string" ? search.label : undefined,
    folder:
      parseFolderKey(typeof search.folder === "string" ? search.folder : undefined) ?? undefined,
    thread: typeof search.thread === "string" ? search.thread : undefined,
    account: typeof search.account === "string" ? search.account : undefined,
  }),
  component: MailRoute,
});

/**
 * Stream (#105, CONTEXT.md): "entered deliberately from Mail ... own route
 * (`/mail/stream`) so reload restores it — Stream is a destination, unlike
 * search (ADR-0017's test)." A sibling of `mailRoute` rather than a search
 * param on it — Stream carries no selection of its own to mirror into the
 * URL (`stream/StreamStack.tsx` "remembers nothing about layout"), so there
 * is nothing for `validateSearch` to do here.
 */
export const streamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail/stream",
  component: StreamRoute,
});

/**
 * The standalone Reader (#292): "Open in new window" opens this in a real
 * browser window (`mail/reader-window.ts`) so a Thread stays open while the
 * User works elsewhere in this one — a route, not a Dialog (the Reader
 * Sheet's own job, `MailSection.tsx`), and a *child* of `rootRoute` like
 * every other screen only because TanStack Router has no other way to reach
 * it: `router/RootLayout.tsx`'s own `isStandaloneReaderPath` check is what
 * actually keeps the Hub's header, Palette and bottom bar off this one path,
 * so "no Hub, no list" is a rendering decision, not a routing one.
 */
export const mailReaderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mail/reader/$threadId",
  component: ReaderRoute,
});

/**
 * Settings' own sub-routes (#99): `settingsRoute` is now a layout route
 * (`SettingsLayout`'s side nav + `<Outlet/>`) rather than a single screen —
 * `/settings` itself carries no content of its own on desktop, redirecting
 * to General the same way `indexRoute` above forwards `/` to Mail. Each
 * child is its own bounded pane (`SettingsLayout`'s own doc comment).
 */
export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsLayout,
});

/**
 * At phone width, `/settings` *is* the entry point (#135): the section list
 * `SettingsLayout` renders full-width, with no rail and no section
 * auto-selected. The redirect-to-General that always fired here only makes
 * sense once a rail is beside the content it selects into — on desktop the
 * redirect still holds, so `/settings` and `/settings/general` keep meaning
 * the same thing there. `isPhoneWidth()` (not the reactive hook: a route's
 * `beforeLoad` isn't a component) reads the same breakpoint `SettingsLayout`
 * itself renders from, so the two never disagree about which one is current.
 */
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    if (!isPhoneWidth()) {
      throw redirect({ to: "/settings/general" });
    }
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

export interface ConnectedAccountsSearch {
  /**
   * The needs-reauth notification/cold-start deep link's target Connected
   * Account (#201, widened by #204 from a Mail Account id —
   * `connected-accounts/account-focus.ts`), paired with `facet` below. Read
   * directly off `window.location.search` by `ConnectedAccountsPage` itself,
   * the same reasoning `mailRoute`'s own `?oauth=` sibling gives — this
   * `validateSearch` exists only so `RootLayout.tsx`'s own `navigate` call
   * type-checks, not because the page reads it through the router.
   */
  account?: string;
  /** Which Facet cell on `account` to focus (#204) — always paired with `account` above. */
  facet?: string;
  /** #116's OAuth callback outcome — same reasoning as `account` above. */
  oauth?: string;
}

export const settingsConnectedAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/connected-accounts",
  validateSearch: (search: Record<string, unknown>): ConnectedAccountsSearch => ({
    account: typeof search.account === "string" ? search.account : undefined,
    facet: typeof search.facet === "string" ? search.facet : undefined,
    oauth: typeof search.oauth === "string" ? search.oauth : undefined,
  }),
  component: ConnectedAccountsPage,
});

/**
 * `/settings/mail-accounts` (#201): the Connected Accounts settings page's
 * old address, kept as a silent redirect rather than removed outright — the
 * needs-reauth notification deep link, the cold-start focus link and every
 * OAuth callback outcome all still name it from wherever they were minted
 * before this ticket landed. `search: true` carries every query param
 * across unchanged (`?account=`, `?oauth=`, and anything else) rather than
 * naming the ones known today, so a future param this redirect was never
 * updated for still survives it.
 */
export const settingsMailAccountsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/mail-accounts",
  beforeLoad: () => {
    throw redirect({ to: "/settings/connected-accounts", search: true });
  },
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

/**
 * Owner-only (#104): `SettingsLayout`'s nav already hides this destination
 * from a Member, but a direct URL still has to go somewhere sane, so
 * `beforeLoad` redirects to General exactly the way `settingsIndexRoute`
 * above forwards a bare `/settings`. `GET /instance/health` itself repeats
 * the check server-side (`routes/instance.ts`'s `requireOwner`) — this is
 * belt, not the only suspender.
 */
export const settingsInstanceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/instance",
  beforeLoad: ({ context }) => {
    if (context.user.role !== "owner") {
      throw redirect({ to: "/settings/general" });
    }
  },
  component: InstancePage,
});

/**
 * Contacts (#211, the App's real screen — no longer a `PlaceholderRoute`):
 * `notesRoute`'s own layout-route shape, the parent renders the card
 * directory rather than only nav chrome. `/contacts/:contactId` and
 * `/contacts/new` are `contactsContactRoute`/`contactsNewRoute` below, not
 * routes of their own declared inline here, so their dialogs render into
 * `ContactsRoute`'s own `<Outlet/>` over the always-mounted grid.
 */
export const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  component: ContactsRoute,
});

/**
 * A `:contactId` that resolves to nothing — a wrong id, or one this Client
 * hasn't synced yet — redirects silently to `/contacts`, `notesNoteRoute`'s
 * own fallback shape. Registered as `contactsNewRoute`'s sibling below, both
 * children of `contactsRoute` — `/new` is checked first by the router's own
 * static-over-dynamic precedence, so a Contact can never legitimately
 * collide with the id `"new"`.
 */
export const contactsContactRoute = createRoute({
  getParentRoute: () => contactsRoute,
  path: "/$contactId",
  beforeLoad: async ({ params }) => {
    await ensureLocalCacheOpen();
    if (!(await contactExists(params.contactId))) {
      throw redirect({ to: "/contacts" });
    }
  },
  component: ContactDialogRoute,
});

/** `/contacts/new` (#211): the grid's own "New contact" entry point — see `NewContactRoute.tsx`'s own doc comment. */
export const contactsNewRoute = createRoute({
  getParentRoute: () => contactsRoute,
  path: "/new",
  component: NewContactRoute,
});

/**
 * Recently Deleted (#224): registered with its own full path directly off
 * `rootRoute`, `notesRecentlyDeletedRoute`'s own precedent — a child of
 * `contactsRoute` instead would render into its own `<Outlet/>` over the
 * always-mounted grid the way the Person Page dialog does, which is wrong
 * here: Recently Deleted is its own screen, not an overlay. TanStack Router
 * still resolves this more specific static path over `contactsContactRoute`'s
 * own dynamic `$contactId` segment, the same static-over-dynamic precedence
 * `contactsNewRoute`'s own doc comment describes.
 */
export const contactsRecentlyDeletedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/recently-deleted",
  component: ContactsRecentlyDeleted,
});

/**
 * `/calendar` (#231, no longer a `PlaceholderRoute`): `view` and `date` are
 * the whole URL, so `validateSearch` falls back to
 * `calendar-url.ts#DEFAULT_CALENDAR_VIEW`/today rather than failing the
 * match on an unrecognized value — the same "old bookmark still lands
 * somewhere sane" posture `mailRoute`'s own `folder` param takes above.
 */
export const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/calendar",
  validateSearch: validateCalendarSearch,
  component: CalendarRoute,
});

/**
 * `/calendar/$eventKey` (#233): the open Event is the URL's path segment,
 * `<seriesId>@<originalStart>` — exactly an `Event`'s own `id`
 * (`@mail/shared#eventSchema`'s own doc comment), so `eventExists` is the
 * whole of the lookup. `notesNoteRoute`'s own shape: a key that resolves to
 * nothing (a wrong id, an old bookmark, an Occurrence outside the synced
 * Event Window) redirects silently to `/calendar` rather than opening an
 * editor with nothing to show.
 */
export const calendarEventRoute = createRoute({
  getParentRoute: () => calendarRoute,
  path: "/$eventKey",
  beforeLoad: async ({ params }) => {
    await ensureLocalCacheOpen();
    if (!(await eventExists(params.eventKey))) {
      throw redirect({ to: "/calendar" });
    }
  },
  component: CalendarEventRoute,
});

/**
 * Tasks (#252/#253): unlike Notes' grid-plus-dialog layout, this is a
 * genuine two-pane split (`TasksApp.tsx`'s own doc comment, `mail/SplitView.tsx`'s
 * shape reused for a different domain) — the selected List is therefore a
 * **search param**, `mailRoute`'s own shape (`folder`/`thread` above), not a
 * path param the way Notes' `:noteId` is: `?list=`/`?view=` are both view
 * *snapshots* of the same `/tasks` screen (#253's own "Foundations' URL
 * shape" line) — `view` reserved for #254/#255/#256's Today/Upcoming/Board,
 * "today"/"upcoming" now read by `TasksRoute.tsx#asTaskView` (#254), Board
 * still unread, shaped from the start so those slices only ever add a
 * reader, never a second search schema.
 *
 * `/tasks/:taskId` (`tasksTaskRoute` below) is the one genuine path param:
 * an *open Task*, not a view snapshot — a permalink that survives a reload
 * distinctly from `?list=`, landing on that Task's own List with its row
 * expanded and scrolled to (`TasksTaskRoute`'s own doc comment).
 */
export interface TasksSearch {
  /** The selected Task List id — unset is the sidebar's own "pick a list" empty state. */
  list?: string;
  /** "today" | "upcoming" (#254) so far, Board (#256) still reserved and unread — an unrecognized value resolves the same as unset (`TasksRoute.tsx#asTaskView`). */
  view?: string;
  /**
   * The Command Palette's own committed query (#262): "'See all results'
   * narrows the Tasks App with the query as a chip on the view" —
   * `TasksApp`'s own read-only filter, never written by a search field of
   * its own (the ticket's own "adds no search field"). Set, this replaces
   * the main column with `TasksSearchResults` regardless of `list`, the
   * same reasoning `search-ux-spec.md`'s ADR-0017 gives Mail's own `?q=`.
   */
  q?: string;
}

export const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks",
  validateSearch: (search: Record<string, unknown>): TasksSearch => ({
    list: typeof search.list === "string" ? search.list : undefined,
    view: typeof search.view === "string" ? search.view : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  component: TasksIndexRoute,
});

/**
 * A `:taskId` that resolves to nothing — soft-deleted, its own List
 * soft-deleted (#257), a wrong id, an old bookmark — redirects silently to
 * `/tasks`, `notesNoteRoute`'s own shape for the same gap. `ensureLocalCacheOpen()`
 * first for the same reason that route awaits it: nothing guarantees the
 * cache has been opened yet on a User landing straight on this route.
 */
export const tasksTaskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/$taskId",
  beforeLoad: async ({ params }) => {
    await ensureLocalCacheOpen();
    if (!(await taskExists(params.taskId))) {
      throw redirect({ to: "/tasks" });
    }
  },
  component: TasksTaskRoute,
});

/**
 * Recently Deleted for Tasks (#257): registered with its own full path
 * directly off `rootRoute`, `notesRecentlyDeletedRoute`'s own precedent for
 * "a screen nested under another App's path, but not actually a child of
 * that App's own route" — a child of `tasksRoute` instead would render into
 * an `<Outlet/>` neither `tasksRoute` nor `tasksTaskRoute` has (both render
 * the whole `TasksApp` directly, no layout wrapper), which is wrong here:
 * Recently Deleted is its own screen (`TasksRecentlyDeleted.tsx`'s own doc
 * comment). Registered ahead of `tasksTaskRoute`'s own dynamic `$taskId`
 * segment in the tree below for exactly the reason that route's own doc
 * comment gives Notes' identical setup: TanStack Router resolves the more
 * specific static path here over a dynamic one, regardless of array order,
 * so "recently-deleted" is never mistaken for a Task id.
 */
export const tasksRecentlyDeletedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/recently-deleted",
  component: TasksRecentlyDeleted,
});

/**
 * Notes (#193, the App's real screen — no longer a `PlaceholderRoute`): a
 * layout route the same shape `settingsRoute` gives Settings, except the
 * parent itself renders the grid rather than only nav chrome — Foundations'
 * path-param routing rule's first real caller (`docs`/mail#190's own
 * framing). `/notes/:noteId` is `notesNoteRoute` below, not a route of its
 * own declared inline here, so its dialog renders into `NotesRoute`'s own
 * `<Outlet/>` over the always-mounted grid.
 */
export const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notes",
  component: NotesRoute,
});

/**
 * A `:noteId` that resolves to nothing — soft-deleted (#194), a wrong id,
 * an old bookmark — redirects silently to `/notes`, the same fallback an
 * unrecognized `folder` search param on `/mail` already takes (this file's
 * own `mailRoute` above). `beforeLoad` rather than a `loader`: every other
 * redirect in this file already throws from `beforeLoad`, and this is the
 * same "gate the match, don't render a screen that has to unwind itself"
 * shape, just checked against the Local Cache instead of route context.
 * `ensureLocalCacheOpen()` is awaited first because nothing guarantees the
 * cache has been opened yet — a User landing straight on this route without
 * ever visiting `/mail` first is exactly Notes' own "first real caller"
 * territory — though a genuinely valid, not-yet-synced deep link (a cold
 * boot racing the first sync round) is a real gap this ticket accepts
 * rather than solves: there is no way to tell "not synced yet" apart from
 * "doesn't exist" from here. Checked with `noteExists` rather than
 * `readNote` directly, so a soft-deleted row (#194) takes this same
 * redirect instead of mounting `NoteDialogRoute` first and leaning on its
 * own `deletedAt` effect — that effect stays, but only as a defense for a
 * delete arriving from sync while the dialog is already open.
 */
export const notesNoteRoute = createRoute({
  getParentRoute: () => notesRoute,
  path: "/$noteId",
  beforeLoad: async ({ params }) => {
    await ensureLocalCacheOpen();
    if (!(await noteExists(params.noteId))) {
      throw redirect({ to: "/notes" });
    }
  },
  component: NoteDialogRoute,
});

/**
 * Recently Deleted (#194): registered with its own full path directly off
 * `rootRoute`, `streamRoute`'s own precedent for "a screen nested under
 * another App's path, but not actually a child of that App's own route" —
 * a child of `notesRoute` instead would render into its `<Outlet/>` over
 * the always-mounted grid the same way the dialog does, which is wrong
 * here: Recently Deleted is its own screen, not an overlay (`NotesRecentlyDeleted.tsx`'s
 * own doc comment). Registered as a sibling of `notesRoute` in the tree
 * below rather than nested under it for exactly that reason — TanStack
 * Router still resolves the more specific static path here over
 * `notesNoteRoute`'s own dynamic `$noteId` segment.
 */
export const notesRecentlyDeletedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notes/recently-deleted",
  component: NotesRecentlyDeleted,
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  mailRoute,
  streamRoute,
  mailReaderRoute,
  settingsRoute.addChildren([
    settingsIndexRoute,
    settingsGeneralRoute,
    settingsThisDeviceRoute,
    settingsConnectedAccountsRoute,
    settingsMailAccountsRoute,
    settingsGatekeeperRoute,
    settingsNotificationsRoute,
    settingsSecurityRoute,
    settingsInstanceRoute,
  ]),
  contactsRoute.addChildren([contactsContactRoute, contactsNewRoute]),
  contactsRecentlyDeletedRoute,
  calendarRoute.addChildren([calendarEventRoute]),
  tasksRoute,
  tasksTaskRoute,
  tasksRecentlyDeletedRoute,
  notesRoute.addChildren([notesNoteRoute]),
  notesRecentlyDeletedRoute,
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
