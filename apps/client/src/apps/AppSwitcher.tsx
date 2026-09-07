import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import { useIsMobile } from "../hooks/use-mobile.js";
import { APPS, appForPath, appIconFor } from "./apps.js";

/**
 * The App Switcher (#72, part of #66; rebuilt against the comp in #86;
 * split from the home mark in #96) — a compact toggle naming the current
 * App. On desktop it expands *in place* into a row of pill tabs naming all
 * four Apps — Mail live, Contacts/Calendar/Tasks named and reachable but
 * marked SOON, never hidden.
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
 * expansion is a plain positioned `div`, not a Radix `Dialog`.
 *
 * Each tab is a router `Link` on both branches, so a reserved App is a real
 * destination (`PlaceholderRoute`) rather than a disabled control.
 */

function AppTabs({
  current,
  onNavigate,
  tabbable = true,
}: {
  current: ReturnType<typeof appForPath>;
  onNavigate: () => void;
  /** Desktop's own inline expansion never unmounts the collapsed tab row —
   * it squeezes `grid-template-columns` to `0fr` — so a closed switcher's
   * links stay in the DOM and would still be keyboard-focusable without
   * this. The phone Sheet unmounts its content on close (Radix `Dialog`
   * `Presence`), so it has no need of the same trick and leaves this at its
   * default. */
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
 * Exported as of #155: the phone bottom bar (`router/BottomBar.tsx`) renders
 * this directly rather than going through `AppSwitcher`'s own `useIsMobile`
 * branch — the bottom bar is already CSS-gated to the app's 700px phone
 * breakpoint, so a second, differently-thresholded JS check here would just
 * be a chance for the two to disagree.
 *
 * `variant="bottom-bar"` swaps the header's icon-plus-chevron trigger for
 * one that matches its two siblings there (Folders, Compose) — the current
 * App's name as a caption, no chevron, since a persistent tab item is never
 * "expanded" the way the header's own disclosure toggle can read. The Sheet
 * itself, and everything in it, is unchanged either way.
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
  variant?: "header" | "bottom-bar";
}) {
  return (
    <>
      {variant === "bottom-bar" ? (
        <button
          type="button"
          className="bottom-bar-item"
          aria-label="Switch app"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <CurrentIcon size={20} />
          <span>{current?.name ?? "Apps"}</span>
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
  const wrapRef = useRef<HTMLDivElement>(null);

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
            <AppTabs current={current} onNavigate={() => setOpen(false)} tabbable={open} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppSwitcher({ pathname }: { pathname: string }) {
  const current = appForPath(pathname);
  const [open, setOpen] = useState(false);
  const isPhone = useIsMobile();
  const CurrentIcon = appIconFor(current?.key ?? "mail");

  return isPhone ? (
    <PhoneSwitcher current={current} CurrentIcon={CurrentIcon} open={open} setOpen={setOpen} />
  ) : (
    <DesktopSwitcher current={current} CurrentIcon={CurrentIcon} open={open} setOpen={setOpen} />
  );
}
