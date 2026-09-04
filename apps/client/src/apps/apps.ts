import type { LucideIcon } from "lucide-react";
import { Calendar, ListChecks, Mail, Users } from "lucide-react";

/**
 * The four Apps the App Switcher names (#72, part of #66): Mail, live today,
 * plus three reserved Apps that are named and reachable — never hidden —
 * long before anything is built behind them. `available: false` is what
 * routes a click to `PlaceholderRoute` instead of a real screen; it is not a
 * disabled state, since the whole point of naming a reserved App is that it
 * stays a real, clickable destination.
 */
export interface AppDef {
  key: string;
  path: string;
  name: string;
  /** The placeholder's one line of what the App will be — never a date, never a waitlist. */
  description: string;
  available: boolean;
}

export const APPS: readonly AppDef[] = [
  {
    key: "mail",
    path: "/mail",
    name: "Mail",
    description: "Read, triage and send your mail.",
    available: true,
  },
  {
    key: "contacts",
    path: "/contacts",
    name: "Contacts",
    description: "Everyone you've written to, gathered in one address book.",
    available: false,
  },
  {
    key: "calendar",
    path: "/calendar",
    name: "Calendar",
    description: "Meetings and events, alongside your mail.",
    available: false,
  },
  {
    key: "tasks",
    path: "/tasks",
    name: "Tasks",
    description: "Turn a thread into something to do.",
    available: false,
  },
];

type AppKey = "mail" | "contacts" | "calendar" | "tasks";

/**
 * One icon per App — the App Switcher's tab row and hub-mark badge, and
 * `PlaceholderRoute`'s own `.ph-icon` (the comp's rounded-square icon tile
 * above a reserved App's heading, `docs/design/prototypes/the-instrument.html`).
 * Declared once here rather than in either consumer, so the two can never
 * pick a different glyph for the same App. Keyed on the literal `AppKey`
 * union, same reasoning as `APPS_BY_KEY` below: a lookup by one of the four
 * known keys skips `noUncheckedIndexedAccess`'s `| undefined` entirely.
 */
export const APP_ICONS: Record<AppKey, LucideIcon> = {
  mail: Mail,
  contacts: Users,
  calendar: Calendar,
  tasks: ListChecks,
};

export function appForPath(pathname: string): AppDef | undefined {
  return APPS.find((app) => pathname.startsWith(app.path));
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
