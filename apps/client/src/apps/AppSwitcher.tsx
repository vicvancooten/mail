import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../components/ui/sheet.js";
import { APPS, appForPath, appIconFor } from "./apps.js";

/** `shell.css`'s own narrow-viewport line (`max-width: 700px`), matching every other Split/List layout switch in the app (`Sidebar.tsx`'s own 700/701px doc comment). */
const NARROW_HEADER_BREAKPOINT = 701;

/**
 * Unlike `Sidebar.tsx`'s folder rail — a CSS-only swap between two always-
 * mounted trees, because the desktop rail's own collapse state has to
 * survive the width the phone sheet appears at — the desktop tab row and the
 * phone sheet trigger share one accessible name ("Switch app") and neither
 * carries state the other needs to inherit, so mounting only the one CSS
 * would show is what keeps a screen reader (and `getByRole`) from ever
 * finding two identically-named controls at once. `window.innerWidth` at the
 * same 700px line `shell.css` uses, corrected on resize.
 */
function useNarrowHeader(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_HEADER_BREAKPOINT);
  useEffect(() => {
    function onResize() {
      setNarrow(window.innerWidth < NARROW_HEADER_BREAKPOINT);
    }
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

/**
 * The App Switcher (#72, part of #66; rebuilt against the comp in #86; split
 * from the home mark in #96; grown to five Apps with a real phone sheet in
 * #187) — a compact toggle naming the current App.
 *
 * Before #96 this toggle *was* the hub mark — the only way home, App
 * identity and App switching were all one control, with no click that just
 * meant "home" and no product name anywhere signed in. `RootLayout.tsx`'s
 * own `HomeLink` now carries the mark + "Wicket" wordmark as a plain `Link`
 * to `/mail`; this component is the *adjacent* control the grill's acceptance
 * box asks for, naming only the current App's icon plus a chevron —
 * deliberately not the postmark any more, so the two controls read as
 * separate affordances rather than one button wearing two hats.
 */
export function AppSwitcher({ pathname }: { pathname: string }) {
  const current = appForPath(pathname);
  const narrow = useNarrowHeader();
  return narrow ? (
    <SwitcherPhoneSheet current={current?.key} />
  ) : (
    <SwitcherDesktop current={current?.key} />
  );
}

/**
 * The desktop switcher (#96's own expand-in-place control, kept intact by
 * #187): two grid cells that trade a `grid-template-columns: 0fr → 1fr`
 * transition (the comp's own `.switcher-cell` in
 * `docs/design/prototypes/the-instrument.html`), so the tab row grows out of
 * the toggle's own position rather than dropping as a menu over the page.
 * That is why this is a pair of cells and a piece of local state instead of
 * a shadcn `DropdownMenu` — a popover cannot animate from zero width in the
 * header's own flow.
 *
 * Each tab is a router `Link`, so a reserved App is a real destination
 * (`PlaceholderRoute`) rather than a disabled control.
 *
 * Five Apps' full names no longer fit every header width once Notes joined
 * the row (#187) — rather than wrap (there is no second line in a 60px
 * header) or let the row bleed past the header's edge, `.tabs-row` measures
 * itself against a hidden clone (`measureRef`) carrying the same five pills
 * at full width, and goes icon-only the moment the real space (`wrapRef`'s
 * own clientWidth, which CSS Grid — not flex shrink-to-fit — keeps pinned to
 * whatever the header's `minmax(0, 1fr)` left column actually has) can't fit
 * it. `ResizeObserver` is a no-op under jsdom (`test-support/dom-polyfills.ts`),
 * same gap `VirtualizedThreadList.tsx` already lives with — a real browser
 * corrects this on layout; a layout-less test only needs both DOM states to
 * render correctly, not the measurement itself.
 */
function SwitcherDesktop({ current }: { current?: string }) {
  const [open, setOpen] = useState(false);
  const [iconOnly, setIconOnly] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const CurrentIcon = appIconFor(current ?? "mail");

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

  // The header's left column (`shell.css`'s `minmax(0, 1fr)` grid track) is
  // what actually bounds this control, not `.switcher-wrap`'s own box — a
  // flex item without `min-grow` only ever reports what it currently needs,
  // which is why the comparison reads `wrapRef`'s *parent* (`.header-left`)
  // rather than `wrapRef` itself.
  useEffect(() => {
    const headerLeft = wrapRef.current?.parentElement;
    const measure = measureRef.current;
    if (!headerLeft || !measure) return;
    function recompute() {
      if (!headerLeft || !measure) return;
      const homeLink = headerLeft.querySelector<HTMLElement>(".home-link");
      const gap = 10; // `.header-left`'s own `gap`
      const available = headerLeft.clientWidth - (homeLink?.offsetWidth ?? 0) - gap;
      setIconOnly(measure.scrollWidth > available);
    }
    const observer = new ResizeObserver(recompute);
    observer.observe(headerLeft);
    recompute();
    return () => observer.disconnect();
  }, []);

  return (
    <div className="switcher-wrap" ref={wrapRef}>
      {/* Off-screen, full-width clone — never `display: none` (that reports
          a zero size), just clipped out of the header's own flow so its
          `scrollWidth` is always the row's true "every name spelled out"
          width regardless of the real row's current open/icon-only state. */}
      <div className="tabs-row tabs-row-measure" ref={measureRef} aria-hidden="true">
        {APPS.map((app) => (
          <span key={app.key} className="tab-pill">
            {app.name}
            {app.available ? null : <span className="tp-soon">SOON</span>}
          </span>
        ))}
      </div>
      <div className={`switcher-cell${open ? " open" : ""}`}>
        <div>
          <button
            type="button"
            className="switcher-compact-btn"
            aria-label="Switch app"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
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
          <div className={`tabs-row${iconOnly ? " icon-only" : ""}`}>
            {APPS.map((app) => {
              const Icon = appIconFor(app.key);
              return (
                <Link
                  key={app.key}
                  to={app.path}
                  className={`tab-pill${app.key === current ? " current" : ""}`}
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

/**
 * The phone switcher (#187): below 700px there's no header width left for an
 * inline-expanding tab row at all, icon-only or otherwise, so the toggle
 * opens a real bottom `Sheet` instead — the same move `Sidebar.tsx`'s own
 * `MobileSheet` made for the folder rail. Unlike the desktop row, this
 * always lists every App's full name: a sheet has the vertical room a 60px
 * header never does, so there's no "out of room" question here to answer.
 */
function SwitcherPhoneSheet({ current }: { current?: string }) {
  const [open, setOpen] = useState(false);
  const CurrentIcon = appIconFor(current ?? "mail");

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="switcher-compact-btn"
          aria-label="Switch app"
          aria-expanded={open}
        >
          <span className="app-tile">
            <CurrentIcon size={15} />
          </span>
          <ChevronDown size={13} className="chev" />
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="switcher-sheet">
        <SheetHeader className="sr-only">
          <SheetTitle>Switch app</SheetTitle>
          <SheetDescription>Choose an App.</SheetDescription>
        </SheetHeader>
        <div className="tabs-row-phone">
          {APPS.map((app) => {
            const Icon = appIconFor(app.key);
            return (
              <Link
                key={app.key}
                to={app.path}
                className={`tab-pill-phone${app.key === current ? " current" : ""}`}
                onClick={() => setOpen(false)}
              >
                <Icon size={16} />
                <span>{app.name}</span>
                {app.available ? null : <span className="tp-soon">SOON</span>}
              </Link>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
