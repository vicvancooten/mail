import { Link } from "@tanstack/react-router";
import { Mark } from "../brand/Mark.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { APPS, appForPath } from "./apps.js";

/**
 * Header-left (#72, part of #66): the hub mark plus an expanding pill naming
 * all four Apps — Mail live, Contacts/Calendar/Tasks named and reachable but
 * marked unavailable, never hidden. One control rather than a nav list of
 * links (`router/routes.tsx`'s comment on the #71-era `.shell-nav`, now
 * retired): the pill's closed state already names the current App, so it
 * doubles as the identity mark `Wordmark` used to be.
 *
 * The same trigger serves the phone case (ticket: "tapping the hub mark
 * opens an App sheet") — `app-switcher-menu`'s own CSS answers a narrow
 * viewport with a bottom sheet instead of a popover, with no second, phone-
 * only component and no bottom tab bar anywhere in the tree.
 */
export function AppSwitcher({ pathname }: { pathname: string }) {
  const current = appForPath(pathname);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="app-switcher-trigger" aria-label="Switch app">
          <Mark size={22} />
          <span className="app-switcher-current">{current?.name ?? "Wicket"}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="app-switcher-menu" align="start">
        {APPS.map((app) => (
          <DropdownMenuItem
            key={app.key}
            asChild
            className="app-switcher-item"
            data-current={app.key === current?.key}
          >
            <Link to={app.path}>
              <span className="app-switcher-item-name">{app.name}</span>
              {!app.available && <span className="app-switcher-item-badge">Not built yet</span>}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
