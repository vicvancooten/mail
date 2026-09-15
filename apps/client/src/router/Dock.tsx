import { useCallback, useState } from "react";
import { PhoneSwitcher } from "../apps/AppSwitcher.js";
import { APPS_BY_KEY, type AppDockControl, appForPath, appIconFor } from "../apps/apps.js";
import { defaultCalendarId } from "../calendar/calendar-create.js";
import { elementAnchorRect, openCreatePanel } from "../calendar/calendar-event-panel.js";
import type { ActionContext } from "../mail/actions/types.js";
import { useCalendars } from "../store/calendars.js";
import { createNote, newNoteId } from "../store/notes.js";
import { rootRoute } from "./routes.js";

/**
 * A Dock control's own `key` (`apps.ts#AppDockControl`) mapped to the
 * `ActionContext` callback it actually runs — behavior the Apps registry
 * itself stays free of (`apps.ts`'s own doc comment on `AppDockControl`),
 * the same split `apps/apps.ts#APP_ICONS` already keeps between "what an
 * App names" and "what actually runs it". Adding a new control an App wants
 * to declare is one entry here plus one in that App's own `dockControls`,
 * never a change to the Dock itself.
 *
 * Only Folders and Compose live here — `"create"` (#345, `useCreateAction`
 * below) deliberately doesn't, even though it's the same "control key →
 * handler" idea. `ActionContext` is what every Mail-family surface
 * (`MailSection`, `stream/StreamStack`) publishes for whichever Thread List
 * or reading pane is actually mounted (`mail/actions/active-mail-host.ts`);
 * Contacts, Calendar, Tasks and Notes are not Mail-family surfaces and
 * publish no `ActionContext` at all, so a table shaped `(ctx) => void` has
 * nothing to call on their own routes.
 */
const DOCK_ACTIONS: Record<string, (ctx: ActionContext) => void> = {
  folders: (ctx) => ctx.onOpenFolders(),
  compose: (ctx) => ctx.onCompose(),
};

/**
 * A fuller spoken name for a control than its short visual caption — the
 * Dock's own `aria-label`s read "New Contact"/"New Event" rather than a bare
 * "New" repeated across four different Apps with nothing to tell them apart
 * out of visual context (`control.label` stays the short caption the tile
 * itself renders; this is only ever what's spoken). Folders/Compose already
 * read fine as their own plain `label`.
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

/** `["Folders", "switch app", "Compose"]` → `"Folders, switch app, and Compose"` — the Dock's own accessible name, built from whichever controls the current App actually declares rather than a string hardcoded to Mail's own two. */
function joinNaturally(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The `"create"` control's own handler (#345), resolved by the *App's* own
 * `key` rather than the control's — `"create"` is one shared control key
 * across Contacts/Calendar/Tasks/Notes (`apps.ts#AppDockControl`'s own doc
 * comment: the same "share a key when the action is conceptually identical"
 * `folders`/`compose` already establish), but what it actually runs is
 * different per App, so the App picks the handler, not the control.
 *
 * The Dock only ever shows one of these Apps' own `dockControls` while that
 * App is genuinely current (`appForPath` on the live `pathname` — unlike
 * Folders/Compose, nothing here falls back to Mail's own controls the way
 * `Dock`'s own `controls` lookup does), so unlike `fallbackCtx`
 * (`RootLayout.tsx`) there is no "pressed from Settings" case to cover: a
 * User can only ever see Contacts' own "New Contact" tile while already on
 * `/contacts`.
 *
 * Each case reuses that App's own existing creation entry point rather than
 * inventing a second one:
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
function useCreateAction(currentKey: string | undefined) {
  const navigate = rootRoute.useNavigate();
  const calendars = useCalendars() ?? [];

  return useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      switch (currentKey) {
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
    [currentKey, navigate, calendars],
  );
}

/**
 * The phone Dock (#298, replacing #155's own bottom bar): a floating pill
 * at the foot of the screen rather than a bar framing it — `shell.css`'s
 * `.dock` — holding the App Switcher tile (`PhoneSwitcher`'s own
 * `variant="dock"` skin) plus whichever of the current App's own
 * `dockControls` (`apps/apps.ts#AppDef.dockControls`) it declares, at most
 * two either side of the switcher tile. An App with fewer than two — or
 * none, `apps.ts`'s own placeholder Apps today — simply renders fewer
 * tiles; there is no empty slot standing in for a control nobody declared.
 *
 * Global chrome, mounted once by `RootLayout.tsx` right beside the header
 * (both retract together on scroll, `RootLayout.tsx`'s own
 * `useChromeRetract`) — `shell.css` hides this above the app's one 768px
 * phone breakpoint (#273), keeping it phone-only the same "both render, CSS
 * decides" way `Sidebar.tsx`'s own `DesktopRail`/`MobileSheet` pair already
 * does, rather than a JS width check that could disagree with the CSS.
 *
 * A Folders/Compose control's `run` is read from `ctx` — whichever
 * Mail-family surface is mounted (`MailSection`, `stream/StreamStack`), or
 * the Hub's own fallback — the same `ActionContext` the Command Palette
 * already reads from `RootLayout`, so both work from Settings or a
 * placeholder App too: the Hub's fallback navigates to Mail first there
 * rather than doing nothing (`onOpenFolders`, `onCompose`), the same shape
 * `onOpenStream` already uses for the Palette. A `"create"` control's `run`
 * is `useCreateAction` above instead — Contacts/Calendar/Tasks/Notes publish
 * no `ActionContext` for it to read. The App Switcher needs neither — it's
 * `PhoneSwitcher` itself (`apps/AppSwitcher.tsx`), reused directly rather
 * than re-implemented.
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
  const controls = current?.dockControls ?? APPS_BY_KEY.mail.dockControls;
  const [before, after] = controls;
  const runCreate = useCreateAction(current?.key);

  const navLabel = joinNaturally(
    [
      before ? controlAccessibleLabel(before, current?.name) : undefined,
      "switch app",
      after ? controlAccessibleLabel(after, current?.name) : undefined,
    ].filter((label): label is string => Boolean(label)),
  );

  return (
    <nav className="dock" aria-label={navLabel}>
      {before && (
        <DockControlButton
          control={before}
          ctx={ctx}
          appName={current?.name}
          onCreate={runCreate}
        />
      )}
      <PhoneSwitcher
        current={current}
        CurrentIcon={CurrentIcon}
        open={switcherOpen}
        setOpen={setSwitcherOpen}
        variant="dock"
      />
      {after && (
        <DockControlButton control={after} ctx={ctx} appName={current?.name} onCreate={runCreate} />
      )}
    </nav>
  );
}

function DockControlButton({
  control,
  ctx,
  appName,
  onCreate,
}: {
  control: AppDockControl;
  ctx: ActionContext;
  appName: string | undefined;
  onCreate: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = control.icon;
  const run = DOCK_ACTIONS[control.key];
  // Compose keeps the one bit of personality the old bottom bar gave it — a
  // quarter turn of the plus on press — everything else about it is the
  // same ghost `dock-item` voice every other tile shares.
  const className = control.key === "compose" ? "dock-item dock-compose" : "dock-item";
  return (
    <button
      type="button"
      className={className}
      aria-label={controlAccessibleLabel(control, appName)}
      onClick={control.key === "create" ? onCreate : () => run?.(ctx)}
    >
      <Icon size={20} />
      <span aria-hidden="true">{control.label}</span>
    </button>
  );
}
