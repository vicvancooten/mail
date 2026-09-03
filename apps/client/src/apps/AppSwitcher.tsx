import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { Calendar, ChevronDown, ListChecks, Mail, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Mark } from "../brand/Mark.js";
import { APPS, appForPath } from "./apps.js";

/**
 * Header-left (#72, part of #66; rebuilt against the comp in #86): the hub
 * mark carrying a badge for whichever App is current, which expands *in
 * place* into a row of pill tabs naming all four Apps — Mail live,
 * Contacts/Calendar/Tasks named and reachable but marked SOON, never
 * hidden.
 *
 * The expansion is the comp's own (`.switcher-cell` in
 * `docs/design/prototypes/the-instrument.html`): two grid cells that trade a
 * `grid-template-columns: 0fr → 1fr` transition, so the tabs grow out of the
 * mark's own position rather than dropping as a menu over the page. That is
 * why this is a pair of cells and a piece of local state instead of the
 * shadcn `DropdownMenu` it used to be — a popover cannot animate from zero
 * width in the header's own flow.
 *
 * Each tab is a router `Link`, so a reserved App is a real destination
 * (`PlaceholderRoute`) rather than a disabled control, and the phone case
 * needs no second component: the tab row is narrow enough to expand in the
 * same rail at any width.
 */

const APP_ICONS: Record<string, LucideIcon> = {
  mail: Mail,
  contacts: Users,
  calendar: Calendar,
  tasks: ListChecks,
};

export function AppSwitcher({ pathname }: { pathname: string }) {
  const current = appForPath(pathname);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const CurrentIcon = APP_ICONS[current?.key ?? "mail"] ?? Mail;

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
      <div className={`switcher-cell${open ? "" : " open"}`}>
        <div>
          <button
            type="button"
            className="switcher-compact-btn"
            aria-label="Switch app"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            <span className="hub-mark">
              <Mark size={21} stroke />
              <span className="app-badge">
                <CurrentIcon size={11} />
              </span>
            </span>
            <ChevronDown size={13} className="chev" />
          </button>
        </div>
      </div>
      <div className={`switcher-cell${open ? " open" : ""}`}>
        <div>
          <div className="tabs-row">
            {APPS.map((app) => {
              const Icon = APP_ICONS[app.key] ?? Mail;
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
