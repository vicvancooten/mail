import type { ConnectedAccountFacetKind } from "@mail/shared";
import type { LucideIcon } from "lucide-react";
import { Calendar, ListChecks, Mail, NotebookText, Users } from "lucide-react";

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
}

export const APPS: readonly AppDef[] = [
  {
    key: "mail",
    path: "/mail",
    name: "Mail",
    description: "Read, triage and send your mail.",
    available: true,
    observesAccountScope: true,
  },
  {
    key: "contacts",
    path: "/contacts",
    name: "Contacts",
    description: "Everyone you've written to, gathered in one address book.",
    available: true,
    observesAccountScope: true,
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
