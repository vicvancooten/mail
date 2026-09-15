import { useCallback, useState } from "react";
import { PhoneSwitcher } from "../apps/AppSwitcher.js";
import { APPS_BY_KEY, type AppDockControl, appForPath, appIconFor } from "../apps/apps.js";
import { defaultCalendarId } from "../calendar/calendar-create.js";
import { elementAnchorRect, openCreatePanel } from "../calendar/calendar-event-panel.js";
import { openCalendarSlideOver } from "../calendar/calendar-slide-over.js";
import type { ActionContext } from "../mail/actions/types.js";
import { useCalendars } from "../store/calendars.js";
import { createNote, newNoteId } from "../store/notes.js";
import { openTasksListsSheet } from "../tasks/tasks-lists-sheet.js";
import { rootRoute } from "./routes.js";

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
 * The `primaryAction` tile's own handler, keyed by the current App — merges
 * what used to be two separate tables (`DOCK_ACTIONS`'s own `compose` entry,
 * reading `ctx.onCompose()`, and this same `useCreateAction`'s own
 * Contacts/Calendar/Tasks/Notes switch) into one, now that Mail's primary
 * action is Compose rather than a Folders/Compose pair either side of the
 * switcher tile (R3, `docs/design/polish-pass.md`): every App names exactly
 * one primary action, so one App-keyed handler covers all five rather than
 * splitting Mail's out into a control-keyed table of its own.
 *
 * Each non-Mail case reuses that App's own existing creation entry point
 * rather than inventing a second one:
 *  - **Contacts**: `/contacts/new` — the grid's own "New contact" `Link`
 *    (`ContactsGrid.tsx`), `NewContactRoute.tsx`'s own screen.
 *  - **Calendar**: `openCreatePanel` — the same module-level panel state
 *    every grid click-to-create call already opens
 *    (`calendar-create.ts#openCreatePanelForDay`, `DayTimeGrid.tsx`'s hour
 *    rows), anchored to the pressed Dock button itself
 *    (`elementAnchorRect`) the same way every other click-to-create call
 *    anchors to whatever was actually clicked. Defaulted to a one-hour Event
 *    starting next on the hour, on the User's own default Calendar
 *    (`defaultCalendarId`) — there is no clicked grid cell here to read a
 *    time or a Calendar from.
 *  - **Tasks**: `/tasks?view=today` — `TaskTodayView.tsx`'s own quick add,
 *    already the one existing "create a Task with no List of its own picked
 *    first" entry point (it creates straight into the User's default Task
 *    List). Reused as-is rather than synthesizing a blank, titleless Task
 *    row directly — every other creation path in this App hands `createTask`
 *    a real title the User already typed, and this is the one screen that
 *    already asks for it with no List to pick first.
 *  - **Notes**: `createNote` + `/notes/$noteId` — Notes has no creation
 *    entry point of its own anywhere yet (unlike the three above, only
 *    "Add to Notes" from a Mail Thread creates one, and that Note carries
 *    the Thread's own Thread Link, not a blank body) — the judgment call
 *    this control's own doc comment above flags. Rather than build a new
 *    screen for it, this mints an id and writes the empty row exactly the
 *    way `createNoteFromThreadLink` already does, then opens
 *    `/notes/$noteId` — the *existing* Note dialog already renders any real
 *    `noteId` directly, with no separate "create mode" to gate behind a
 *    dedicated route the way `ContactDialog`'s `contactId: null` needs.
 */
function usePrimaryAction(
  currentKey: string | undefined,
  ctx: ActionContext,
): (event: React.MouseEvent<HTMLButtonElement>) => void {
  const navigate = rootRoute.useNavigate();
  const calendars = useCalendars() ?? [];

  return useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      switch (currentKey) {
        case "mail":
          ctx.onCompose();
          return;
        case "contacts":
          void navigate({ to: "/contacts/new" });
          return;
        case "calendar": {
          const calendarId = defaultCalendarId(new Map(calendars.map((cal) => [cal.id, cal])));
          if (!calendarId) return;
          const start = new Date();
          start.setMinutes(0, 0, 0);
          start.setHours(start.getHours() + 1);
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          openCreatePanel({
            calendarId,
            start: start.toISOString(),
            end: end.toISOString(),
            allDay: false,
            anchorRect: elementAnchorRect(event.currentTarget),
          });
          return;
        }
        case "tasks":
          void navigate({ to: "/tasks", search: { view: "today" } });
          return;
        case "notes": {
          const id = newNoteId();
          void (async () => {
            await createNote(id);
            void navigate({ to: "/notes/$noteId", params: { noteId: id } });
          })();
          return;
        }
        default:
          return;
      }
    },
    [currentKey, ctx, navigate, calendars],
  );
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
  const runPrimaryAction = usePrimaryAction(current?.key ?? "mail", ctx);

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
      <DockTile control={app.primaryAction} appName={app.name} onClick={runPrimaryAction} />
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
