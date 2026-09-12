import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { useIsPhoneWidth } from "../hooks/use-phone-width.js";
import { APPS, appForPath, appIconFor } from "./apps.js";

/**
 * The App Switcher (#72, part of #66; rebuilt against the comp in #86; split
 * from the home mark in #96; grown to five Apps with a real phone sheet in
 * #187) — a compact toggle naming the current App. On desktop it expands *in
 * place* into a row of pill tabs naming all five Apps — Mail and Notes live,
 * Contacts/Calendar/Tasks named and reachable but marked SOON, never hidden.
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
 * The desktop expansion is the comp's own (`.switcher-cell` in
 * `docs/design/prototypes/the-instrument.html`): two grid cells that trade a
 * `grid-template-columns: 0fr → 1fr` transition, so the tabs grow out of the
 * toggle's own position rather than dropping as a menu over the page. That is
 * why this is a pair of cells and a piece of local state instead of the
 * shadcn `DropdownMenu` it used to be — a popover cannot animate from zero
 * width in the header's own flow.
 *
 * A phone has no room for that inline row (#136, mail#133's own "Phone bugs
 * fixed now" decision): the header track is only wide enough for the toggle
 * itself, so at phone width the same toggle instead opens the tab row as a
 * bottom `Sheet` — the same shadcn `Sheet` (Radix `Dialog`) `Sidebar.tsx`'s
 * own phone rail already uses, which is why outside-tap and Escape need no
 * hand-rolled listener on this branch: Radix's `Dialog` already dismisses on
 * both, over pointer events, so touch closes it the same way a mouse would.
 * The desktop branch keeps its own manual listeners, since the inline
 * expansion is a plain positioned `div`, not a Radix `Dialog`. `useIsPhoneWidth`
 * (the app's one 768px breakpoint, #273) is the line between the two
 * branches — `RootLayout.tsx` reads this same hook for `isPhoneChrome`, so
 * the header's own instance of this component and the phone Dock's are
 * never both mounted at once (see `PhoneSwitcher` below).
 *
 * Each tab is a router `Link` on both branches, so a reserved App is a real
 * destination (`PlaceholderRoute`) rather than a disabled control.
 */
export function AppSwitcher({ pathname }: { pathname: string }) {
  const current = appForPath(pathname);
  const [open, setOpen] = useState(false);
  const isPhone = useIsPhoneWidth();
  const CurrentIcon = appIconFor(current?.key ?? "mail");

  return isPhone ? (
    <PhoneSwitcher current={current} CurrentIcon={CurrentIcon} open={open} setOpen={setOpen} />
  ) : (
    <DesktopSwitcher current={current} CurrentIcon={CurrentIcon} open={open} setOpen={setOpen} />
  );
}

/**
 * The tab row shared by both the phone Sheet and the desktop expansion — one
 * `<Link>` per App, always rendered (a reserved App is a real destination),
 * `tabbable` letting the desktop branch keep its collapsed row's links out
 * of tab order without unmounting them (see `DesktopSwitcher` below; the
 * phone Sheet unmounts its content on close via Radix `Dialog` `Presence`,
 * so it has no need of the same trick and leaves this at its default).
 */
function AppTabs({
  current,
  onNavigate,
  tabbable = true,
}: {
  current: ReturnType<typeof appForPath>;
  onNavigate: () => void;
  tabbable?: boolean;
}) {
  return (
    <>
      {APPS.map((app) => {
        const Icon = appIconFor(app.key);
        return (
          <Link
            key={app.key}
            to={app.path}
            className={`tab-pill${app.key === current?.key ? " current" : ""}`}
            tabIndex={tabbable ? undefined : -1}
            onClick={onNavigate}
          >
            <Icon size={14} />
            <span>{app.name}</span>
            {app.available ? null : <span className="tp-soon">SOON</span>}
          </Link>
        );
      })}
    </>
  );
}

/**
 * The phone switcher (#136, exported as of #155): below the app's one 768px
 * phone breakpoint there's no header width left for an inline-expanding tab
 * row at all, icon-only or otherwise, so the toggle opens a real bottom
 * `Sheet` instead — the same move `Sidebar.tsx`'s own `MobileSheet` made for
 * the folder rail. Unlike the desktop row, this always lists every App's
 * full name (five, since #187): a sheet has the vertical room a 60px header
 * never does, so there's no "out of room" question here to answer.
 *
 * The phone Dock (`router/Dock.tsx`, #298) renders this directly rather
 * than going through `AppSwitcher`'s own `useIsPhoneWidth` branch — the Dock
 * is already CSS-gated to that same 768px phone breakpoint (#273 unified
 * the two this app used to carry), so a second JS check here would just be
 * a chance for the two to disagree. `variant="dock"` swaps the header's
 * icon-plus-chevron trigger for one styled to read as its own control
 * rather than as a caption sitting between the Dock's other two tiles
 * (#298's own acceptance box: "the switcher tile reads as tappable/a
 * control, not a label") — a filled tile behind the current App's icon plus
 * an upward chevron (the Sheet it opens rises from the foot of the screen,
 * `ChevronDown`'s own mirror), rather than bare icon-over-caption text
 * identical in weight to Folders/Compose beside it. The Sheet itself, and
 * everything in it, is unchanged either way.
 */
export function PhoneSwitcher({
  current,
  CurrentIcon,
  open,
  setOpen,
  variant = "header",
}: {
  current: ReturnType<typeof appForPath>;
  CurrentIcon: ReturnType<typeof appIconFor>;
  open: boolean;
  setOpen: (open: boolean) => void;
  variant?: "header" | "dock";
}) {
  return (
    <>
      {variant === "dock" ? (
        <button
          type="button"
          className="dock-switcher"
          aria-label="Switch app"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span className="app-tile">
            <CurrentIcon size={18} />
          </span>
          <span>{current?.name ?? "Apps"}</span>
          <ChevronUp size={13} className="dock-switcher-chev" />
        </button>
      ) : (
        <button
          type="button"
          className="switcher-compact-btn"
          aria-label="Switch app"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span className="app-tile">
            <CurrentIcon size={15} />
          </span>
          <ChevronDown size={13} className="chev" />
        </button>
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="switcher-sheet">
          <SheetHeader className="sr-only">
            <SheetTitle>Switch app</SheetTitle>
            <SheetDescription>Choose an App to open.</SheetDescription>
          </SheetHeader>
          <div className="tabs-row">
            <AppTabs current={current} onNavigate={() => setOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </>
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
 *
 * The two real cells carry their own `-toggle`/`-tabs` modifier classes
 * (`shell.css`) rather than leaning on `:first-child`/`:last-child` (#280):
 * the measuring row above is a real DOM sibling and sits before them, so the
 * toggle cell was never actually its parent's *first* child — `:first-child`
 * matched nothing, and the toggle silently sized as the bare `.switcher-cell`
 * default (zero width) whether open or closed.
 */
function DesktopSwitcher({
  current,
  CurrentIcon,
  open,
  setOpen,
}: {
  current: ReturnType<typeof appForPath>;
  CurrentIcon: ReturnType<typeof appIconFor>;
  open: boolean;
  setOpen: (open: boolean | ((current: boolean) => boolean)) => void;
}) {
  const [iconOnly, setIconOnly] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);

  // The collapsed toggle's own discovery hint (#280): a sliver of the *next*
  // App's mark peeking from behind the current one, so a control with no
  // persistent icon row still says "there's more here" at rest. Wraps
  // rather than reading past the end, since the switcher cycles Mail →
  // Contacts → … → Mail.
  const currentKey = current?.key ?? "mail";
  const currentIndex = APPS.findIndex((app) => app.key === currentKey);
  const nextApp = APPS[(currentIndex + 1) % APPS.length];
  const NextIcon = appIconFor(nextApp?.key ?? currentKey);

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
  }, [open, setOpen]);

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
      <div className={`switcher-cell switcher-cell-toggle${open ? " open" : ""}`}>
        <div>
          <button
            type="button"
            className="switcher-compact-btn"
            aria-label="Switch app"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="app-tile-stack">
              <span className="app-tile app-tile-peek" aria-hidden="true">
                <NextIcon size={12} />
              </span>
              <span className="app-tile">
                <CurrentIcon size={15} />
              </span>
            </span>
            <ChevronDown size={13} className="chev" />
          </button>
        </div>
      </div>
      <div className={`switcher-cell switcher-cell-tabs${open ? " open" : ""}`}>
        <div>
          <div className={`tabs-row${iconOnly ? " icon-only" : ""}`}>
            <AppTabs current={current} onNavigate={() => setOpen(false)} tabbable={open} />
          </div>
        </div>
      </div>
    </div>
  );
}
