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

export function appForPath(pathname: string): AppDef | undefined {
  return APPS.find((app) => pathname.startsWith(app.path));
}

/** Indexed lookup for the reserved Apps' own route components, which know their key at compile time and would otherwise need a non-null assertion on `Array.find`. */
export const APPS_BY_KEY: Record<string, AppDef> = Object.fromEntries(
  APPS.map((app) => [app.key, app]),
);
