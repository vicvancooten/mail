import { useCallback, useState } from "react";
import { PhoneSwitcher } from "../apps/AppSwitcher.js";
import { APPS_BY_KEY, type AppDockControl, appForPath, appIconFor } from "../apps/apps.js";
import { usePrimaryAction } from "../apps/primary-action.js";
import { openCalendarSlideOver } from "../calendar/calendar-slide-over.js";
import type { ActionContext } from "../mail/actions/types.js";
import { openTasksListsSheet } from "../tasks/tasks-lists-sheet.js";

/**
 * A fuller spoken name for a control than its short visual caption — the
 * Dock's own `aria-label`s read "New Contact"/"New Event" rather than a bare
 * "New" repeated across four different Apps with nothing to tell them apart
 * out of visual context (`control.label` stays the short caption the tile
 * used to render before #318 removed every caption; this is only ever what's
 * spoken now). Folders/Compose/Calendars/Lists already read fine as their
 * own plain `label`.
 */
function controlAccessibleLabel(control: AppDockControl, appName: string | undefined): string {
  if (control.key !== "create" || !appName) return control.label;
  const noun: Record<string, string> = {
    Contacts: "Contact",
    Calendar: "Event",
    Tasks: "Task",
    Notes: "Note",
  };
  return `New ${noun[appName] ?? appName}`;
}

/** `["switch app", "Folders", "Compose"]` → `"switch app, Folders, and Compose"` — the Dock's own accessible name, built from whichever controls the current App actually declares rather than a string hardcoded to Mail's own two. */
function joinNaturally(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The `navControl` tile's own handler, keyed by the current App rather than
 * by the control's own `key` — unlike `primaryAction` below, none of these
 * three (Folders, Calendars, Lists) share a generic key the way `"create"`
 * does, since each opens a genuinely different kind of surface (a Sheet, a
 * module-level slide-over, a bare navigation):
 *  - **Mail (Folders)**: `ctx.onOpenFolders()` — the same `ActionContext`
 *    callback the desktop folder rail's own Sheet trigger already calls.
 *  - **Calendar (Calendars)**: `openCalendarSlideOver()`
 *    (`calendar-slide-over.ts`) — a module-level opener, the same shape
 *    `calendar-event-panel.ts` already uses for the create/edit/task
 *    popover, since the Dock has no component ancestry in common with
 *    `CalendarRoute`'s own toolbar button that opens the identical
 *    slide-over.
 *  - **Tasks (Lists)**: `openTasksListsSheet()` (`tasks/tasks-lists-sheet.ts`,
 *    #321) — the same module-level opener shape the Calendars tile already
 *    uses, since the Dock has no component ancestry in common with wherever
 *    the Sheet actually mounts (`TasksApp.tsx`).
 */
function useNavControlAction(currentKey: string | undefined, ctx: ActionContext): () => void {
  return useCallback(() => {
    switch (currentKey) {
      case "mail":
        ctx.onOpenFolders();
        return;
      case "calendar":
        openCalendarSlideOver();
        return;
      case "tasks":
        openTasksListsSheet();
        return;
      default:
        return;
    }
  }, [currentKey, ctx]);
}

/**
 * The phone Dock (#298, replaced with a blurred glass pill in #318): a
 * floating pill at the foot of the screen holding, in order, the App
 * Switcher tile, the current App's `navControl` if it declares one, and its
 * `primaryAction` (`apps/apps.ts#AppDef`) — `[switcher][nav?][primary]`,
 * never more than three tiles (R3, decision B, `docs/design/polish-pass.md`).
 * Contacts and Notes name no `navControl`, so their Dock is a two-tile pill.
 *
 * Every tile is icon-only with an `aria-label` — no caption text survives
 * inside the pill (#318's own acceptance box), unlike the ghost
 * icon-over-caption tiles this replaces.
 *
 * Global chrome, mounted once by `RootLayout.tsx` right beside the header
 * (both retract together on scroll, `RootLayout.tsx`'s own
 * `useChromeRetract`) — `shell.css` hides this above the app's one 768px
 * phone breakpoint (#273), keeping it phone-only the same "both render, CSS
 * decides" way `Sidebar.tsx`'s own `DesktopRail`/`MobileSheet` pair already
 * does, rather than a JS width check that could disagree with the CSS.
 */
export function Dock({ pathname, ctx }: { pathname: string; ctx: ActionContext }) {
  const current = appForPath(pathname);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const CurrentIcon = appIconFor(current?.key ?? "mail");
  // A pathname matching no App (Settings, the standalone Reader's own
  // fallback before it early-returns in `RootLayout.tsx`) falls back to
  // Mail's own two — the same "show it anyway" default `appIconFor` and
  // `accountScopeFacetForApp` (`apps.ts`) already take for a pathname with
  // no matching App, and what keeps Folders/Compose reachable from Settings
  // (`fallbackCtx`'s own "navigate to Mail first" shape, `RootLayout.tsx`).
  const app = current ?? APPS_BY_KEY.mail;
  const runNavControl = useNavControlAction(current?.key ?? "mail", ctx);
  // `apps/primary-action.ts` shared with the desktop header's own
  // `<PrimaryAction>` (`RootLayout.tsx`) — the same per-App handler
  // resolution used to live here as a second copy. `app.primaryAction`
  // (not `primary.icon`/`primary.label`) still drives the tile's own icon
  // and accessible name below, since `controlAccessibleLabel` needs the raw
  // `AppDockControl` (`key`) to build "New Contact" rather than the plain
  // "New contact" caption the hook hands back.
  const primary = usePrimaryAction(current?.key ?? "mail", ctx);

  const navLabel = joinNaturally(
    [
      "switch app",
      app.navControl ? controlAccessibleLabel(app.navControl, app.name) : undefined,
      controlAccessibleLabel(app.primaryAction, app.name),
    ].filter((label): label is string => Boolean(label)),
  );

  return (
    <nav className="dock" aria-label={navLabel}>
      <PhoneSwitcher
        current={current}
        CurrentIcon={CurrentIcon}
        open={switcherOpen}
        setOpen={setSwitcherOpen}
        variant="dock"
      />
      {app.navControl && (
        <DockTile control={app.navControl} appName={app.name} onClick={runNavControl} />
      )}
      {primary && (
        <DockTile control={app.primaryAction} appName={app.name} onClick={primary.onClick} />
      )}
    </nav>
  );
}

function DockTile({
  control,
  appName,
  onClick,
}: {
  control: AppDockControl;
  appName: string | undefined;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = control.icon;
  // Compose keeps the one bit of personality the old bottom bar gave it — a
  // quarter turn of the plus on press — everything else about it is the
  // same ghost `dock-item` voice every other tile shares.
  const className = control.key === "compose" ? "dock-item dock-compose" : "dock-item";
  return (
    <button
      type="button"
      className={className}
      aria-label={controlAccessibleLabel(control, appName)}
      onClick={onClick}
    >
      <Icon size={20} />
    </button>
  );
}
