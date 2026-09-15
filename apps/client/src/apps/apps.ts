import type { ConnectedAccountFacetKind } from "@mail/shared";
import type { LucideIcon } from "lucide-react";
import { Calendar, ListChecks, Mail, NotebookText, PanelLeft, Plus, Users } from "lucide-react";

/**
 * One control the phone Dock (`router/Dock.tsx`) can render as a tile — the
 * primary action every App names exactly one of (`AppDef.primaryAction`,
 * R3 `docs/design/polish-pass.md`) or the optional secondary nav control
 * some Apps also name (`AppDef.navControl`). Purely a display declaration —
 * `key` is what `router/Dock.tsx` maps to an actual handler (an
 * `ActionContext` callback for Mail's Folders/Compose, a per-App creation
 * entry point for everyone else's primary action, a module-level opener for
 * Calendar's Calendars), the same "Apps registry stays behavior-free" split
 * `APP_ICONS` already keeps for the App Switcher.
 */
export interface AppDockControl {
  /** What `router/Dock.tsx`'s own lookup maps to a runnable handler — never read as display text itself. */
  key: string;
  label: string;
  icon: LucideIcon;
}

/**
 * The five Apps the App Switcher names (#72, part of #66; grown to five and
 * given per-App Account Scope in #187): Mail, Notes (#193) and, since #252,
 * Tasks are live; Contacts and Calendar stay reserved — named and reachable,
 * never hidden — long before anything is built behind them. `available:
 * false` is what routes a click to `PlaceholderRoute` instead of a real
 * screen; it is not a disabled state, since the whole point of naming a
 * reserved App is that it stays a real, clickable destination. Notes and
 * Tasks were each reserved the same way Contacts/Calendar still are, until
 * their own epics (`mail#190`, `mail#249`) landed behind them.
 */
export interface AppDef {
  key: string;
  path: string;
  name: string;
  /** The placeholder's one line of what the App will be — never a date, never a waitlist. */
  description: string;
  available: boolean;
  /**
   * Whether narrowing to a subset of the User's Mail Accounts means anything
   * for this App's data (#187) — Mail, Calendar and Contacts read a Mail
   * Account's data, so Scope narrows what they show; Tasks and Notes belong
   * to the User alone, so a Scope over Mail Accounts has nothing to narrow.
   * `RootLayout.tsx` reads this to hide the Hub's Account Scope control
   * rather than rendering it disabled or empty.
   */
  observesAccountScope: boolean;
  /**
   * The App's one primary action (R3 `docs/design/polish-pass.md`) — the
   * solid accent pill in the desktop header and the phone Dock's trailing
   * tile (`router/Dock.tsx` renders `[switcher][navControl?][primaryAction]`).
   * Every App names exactly one: Compose (Mail), New contact (Contacts),
   * New event (Calendar), New task (Tasks), New note (Notes).
   */
  primaryAction: AppDockControl;
  /**
   * A second Dock tile some Apps declare, ahead of `primaryAction` — Mail's
   * Folders, Calendar's Calendars, Tasks' Lists. Contacts and Notes name
   * none, so their Dock is a two-tile pill (switcher, primary action)
   * rather than three.
   */
  navControl?: AppDockControl;
}

export const APPS: readonly AppDef[] = [
  {
    key: "mail",
    path: "/mail",
    name: "Mail",
    description: "Read, triage and send your mail.",
    available: true,
    observesAccountScope: true,
    // Folders opens the same Sheet the desktop folder rail lives in;
    // Compose starts a new draft — the pair `router/Dock.tsx` (née
    // `BottomBar.tsx`) used to hardcode, now declared here instead.
    navControl: { key: "folders", label: "Folders", icon: PanelLeft },
    primaryAction: { key: "compose", label: "Compose", icon: Plus },
  },
  {
    key: "contacts",
    path: "/contacts",
    name: "Contacts",
    description: "Everyone you've written to, gathered in one address book.",
    available: true,
    observesAccountScope: true,
    // "create": the shared key Calendar/Tasks/Notes below all reuse
    // too — conceptually one action ("start creating") the same way
    // `folders` is already a shared key naming a Mail-specific behaviour
    // behind a generic label. `router/Dock.tsx`'s own doc comment on its
    // App-keyed handler resolution is where each App's own "create" key
    // actually resolves to that App's real creation entry point.
    primaryAction: { key: "create", label: "New contact", icon: Plus },
  },
  {
    key: "calendar",
    path: "/calendar",
    name: "Calendar",
    description: "Meetings and events, alongside your mail.",
    // Real behind this since #231 — the grid and its five views, the App's
    // first built-out screen (Notes' own #193 precedent above).
    available: true,
    observesAccountScope: true,
    // Calendars opens the existing slide-over (`calendar-slide-over.ts`'s
    // module-level opener, `CalendarRoute.tsx`'s own toolbar button reuses
    // the same one).
    navControl: { key: "calendars", label: "Calendars", icon: PanelLeft },
    primaryAction: { key: "create", label: "New event", icon: Plus },
  },
  {
    key: "tasks",
    path: "/tasks",
    name: "Tasks",
    description: "Turn a thread into something to do.",
    // Real behind this since #252 — a Task List's sidebar, its rows and
    // quick add, `notes`'s own "first built-out screen" precedent.
    available: true,
    observesAccountScope: false,
    // Lists opens the rail as a phone Sheet (#321, `tasks/tasks-lists-sheet.ts`'s
    // module-level opener, `router/Dock.tsx`'s own comment on the tile's
    // handler) — `PanelLeft` matches Mail's Folders/Calendar's Calendars
    // rather than inventing a third glyph for "open a rail".
    navControl: { key: "lists", label: "Lists", icon: PanelLeft },
    primaryAction: { key: "create", label: "New task", icon: Plus },
  },
  {
    key: "notes",
    path: "/notes",
    name: "Notes",
    description: "Quick notes, alongside your mail.",
    // Real behind this since #193 — the grid and dialog editing, Notes'
    // first built-out screen.
    available: true,
    observesAccountScope: false,
    primaryAction: { key: "create", label: "New note", icon: Plus },
  },
];

type AppKey = "mail" | "contacts" | "calendar" | "tasks" | "notes";

/**
 * One icon per App — the App Switcher's tab row and hub-mark badge, and
 * `PlaceholderRoute`'s own `.ph-icon` (the comp's rounded-square icon tile
 * above a reserved App's heading, `docs/design/prototypes/the-instrument.html`).
 * Declared once here rather than in either consumer, so the two can never
 * pick a different glyph for the same App. Keyed on the literal `AppKey`
 * union, same reasoning as `APPS_BY_KEY` below: a lookup by one of the five
 * known keys skips `noUncheckedIndexedAccess`'s `| undefined` entirely.
 */
export const APP_ICONS: Record<AppKey, LucideIcon> = {
  mail: Mail,
  contacts: Users,
  calendar: Calendar,
  tasks: ListChecks,
  notes: NotebookText,
};

export function appForPath(pathname: string): AppDef | undefined {
  return APPS.find((app) => pathname.startsWith(app.path));
}

/**
 * Which Connected Account Facet an `observesAccountScope` App's data rides
 * (#207) — `mail`/`calendar`/`contacts` all share their `AppDef.key` with
 * their `ConnectedAccountFacetKind`, so this is a lookup rather than a
 * second table to keep in sync. Never called for Tasks/Notes
 * (`observesAccountScope: false` already hides the picker for both), and
 * falls back to `"mail"` for the one caller (`RootLayout.tsx`) that can
 * still hand it `undefined` — a pathname matching no App, the same "show it
 * anyway" default `observesAccountScope ?? true` already takes there.
 */
export function accountScopeFacetForApp(app: AppDef | undefined): ConnectedAccountFacetKind {
  return app?.key === "calendar" || app?.key === "contacts" ? app.key : "mail";
}

/**
 * `APP_ICONS` keyed by a plain `AppDef["key"]` string (`current?.key`,
 * `app.key`) rather than the narrower `AppKey` union — every real call site
 * already holds one of the four known keys, but only `AppKey` itself proves
 * that to the type-checker, so this is the one place that gap is bridged,
 * falling back to Mail's own icon the same way `appForPath` callers already
 * fall back to it.
 */
export function appIconFor(key: string): LucideIcon {
  return (APP_ICONS as Record<string, LucideIcon>)[key] ?? Mail;
}

/** Indexed lookup for the reserved Apps' own route components, which know their key at compile time and would otherwise need a non-null assertion on `Array.find`. Keyed on the literal `AppKey` union rather than `string`, so a lookup by one of the four known keys skips `noUncheckedIndexedAccess`'s `| undefined` entirely. `Object.fromEntries` only infers a `string` index signature, so the cast asserts what `APPS` above already guarantees: every `AppKey` has a matching entry. */
export const APPS_BY_KEY = Object.fromEntries(APPS.map((app) => [app.key, app])) as Record<
  AppKey,
  AppDef
>;
