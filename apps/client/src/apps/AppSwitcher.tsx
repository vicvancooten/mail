import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { APPS, appForPath, appIconFor } from "./apps.js";

/**
 * The App Switcher (#72, part of #66; rebuilt against the comp in #86;
 * split from the home mark in #96) — a compact toggle naming the current
 * App, which expands *in place* into a row of pill tabs naming all four
 * Apps — Mail live, Contacts/Calendar/Tasks named and reachable but marked
 * SOON, never hidden.
 *
 * Before #96 this toggle *was* the hub mark — the only way home, App
 * identity and App switching were all one control, with no click that just
 * meant "home" and no product name anywhere signed in. `RootLayout.tsx`'s
 * own `HomeLink` now carries the mark + "Wicket" wordmark as a plain `Link`
 * to `/mail`; this component is the *adjacent* control the grill's
 * acceptance box asks for, naming only the current App's icon plus a
 * chevron — deliberately not the postmark any more, so the two controls
 * read as separate affordances rather than one button wearing two hats.
 *
 * The expansion is the comp's own (`.switcher-cell` in
 * `docs/design/prototypes/the-instrument.html`): two grid cells that trade a
 * `grid-template-columns: 0fr → 1fr` transition, so the tabs grow out of the
 * toggle's own position rather than dropping as a menu over the page. That is
 * why this is a pair of cells and a piece of local state instead of the
 * shadcn `DropdownMenu` it used to be — a popover cannot animate from zero
 * width in the header's own flow.
 *
 * Each tab is a router `Link`, so a reserved App is a real destination
 * (`PlaceholderRoute`) rather than a disabled control, and the phone case
 * needs no second component: the tab row is narrow enough to expand in the
 * same rail at any width.
 */

export function AppSwitcher({ pathname }: { pathname: string }) {
  const current = appForPath(pathname);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const CurrentIcon = appIconFor(current?.key ?? "mail");

  // A click anywhere else, or Escape, closes it — the comp's own two exits.
  // Bound only while open, so the shell carries no idle document listener.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="switcher-wrap" ref={wrapRef}>
      <div className={`switcher-cell${open ? " open" : ""}`}>
        <div>
          <button
            type="button"
            className="switcher-compact-btn"
            aria-label="Switch app"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span className="app-tile">
              <CurrentIcon size={15} />
            </span>
            <ChevronDown size={13} className="chev" />
          </button>
        </div>
      </div>
      <div className={`switcher-cell${open ? " open" : ""}`}>
        <div>
          <div className="tabs-row">
            {APPS.map((app) => {
              const Icon = appIconFor(app.key);
              return (
                <Link
                  key={app.key}
                  to={app.path}
                  className={`tab-pill${app.key === current?.key ? " current" : ""}`}
                  tabIndex={open ? undefined : -1}
                  onClick={() => setOpen(false)}
                >
                  <Icon size={14} />
                  <span>{app.name}</span>
                  {app.available ? null : <span className="tp-soon">SOON</span>}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
