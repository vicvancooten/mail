import type { ConnectedAccountFacetKind } from "@mail/shared";
import type { LucideIcon } from "lucide-react";
import { Calendar, ListChecks, Mail, NotebookText, PanelLeft, Plus, Users } from "lucide-react";

/**
 * One of an App's own Dock controls (#298) — the Dock's floating pill holds
 * the App Switcher tile plus whichever of these an App declares, at most
 * two (the phone Dock's whole width budget beside the switcher tile). Purely
 * a display declaration — `key` is what `router/Dock.tsx` maps to an actual
 * handler (an `ActionContext` callback today; nothing here reaches into
 * Mail's own action vocabulary, the same "Apps registry stays behavior-free"
 * split `APP_ICONS` already keeps for the App Switcher). An App with fewer
 * than two — or none — simply lists fewer; the Dock renders exactly as many
 * tiles as `dockControls` names, no placeholder slots.
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
   * This App's two most-used controls, in the phone Dock (#298) — at most
   * two, in the order the Dock renders them either side of the switcher
   * tile. Mail names its two (Folders, Compose); an App that hasn't named
   * any yet renders none, the same "reserved but not fully built out"
   * posture `available: false` already gives a whole App above.
   */
  dockControls: readonly AppDockControl[];
}

export const APPS: readonly AppDef[] = [
  {
    key: "mail",
    path: "/mail",
    name: "Mail",
    description: "Read, triage and send your mail.",
    available: true,
    observesAccountScope: true,
    // The phone Dock's own two (#298, the ticket's own worked example):
    // Folders opens the same Sheet the desktop folder rail lives in,
    // Compose starts a new draft — the pair `router/Dock.tsx` (née
    // `BottomBar.tsx`) used to hardcode, now declared here instead.
    dockControls: [
      { key: "folders", label: "Folders", icon: PanelLeft },
      { key: "compose", label: "Compose", icon: Plus },
    ],
  },
  {
    key: "contacts",
    path: "/contacts",
    name: "Contacts",
    description: "Everyone you've written to, gathered in one address book.",
    available: true,
    observesAccountScope: true,
    // No Dock controls named yet — a future ticket's own worked example,
    // not this one's.
    dockControls: [],
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
    dockControls: [],
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
    dockControls: [],
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
    dockControls: [],
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
