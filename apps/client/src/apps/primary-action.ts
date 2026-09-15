import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";
import { defaultCalendarId } from "../calendar/calendar-create.js";
import { elementAnchorRect, openCreatePanel } from "../calendar/calendar-event-panel.js";
import type { ActionContext } from "../mail/actions/types.js";
import { rootRoute } from "../router/routes.js";
import { useCalendars } from "../store/calendars.js";
import { createNote, newNoteId } from "../store/notes.js";
import { APPS_BY_KEY, type AppDef } from "./apps.js";

/** What `usePrimaryAction` hands back to a caller — the label/icon pair a
 * `.btn-primary` (`controls.css`) or a `DockTile` renders, plus the one
 * handler that actually runs the App's primary action. `null` only when
 * `appKey` resolves to no App at all (defensive — the `?? "mail"` fallback
 * below means every real caller always gets one back). */
export interface PrimaryAction {
  icon: LucideIcon;
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/** `APPS_BY_KEY` indexed by a plain string rather than the narrower `AppKey`
 * union it's typed against — the same bridge `apps.ts#appIconFor` already
 * does for a lookup key that's only known to be one of the five at runtime,
 * not at compile time. */
function appDefFor(key: string): AppDef | undefined {
  return (APPS_BY_KEY as Record<string, AppDef>)[key];
}

/**
 * The one primary action every App declares (R3, `docs/design/polish-pass.md`,
 * decision C): Compose (Mail), New contact (Contacts), New event (Calendar),
 * New task (Tasks), New note (Notes). Both the desktop header's
 * `<PrimaryAction>` (`router/RootLayout.tsx`) and the phone Dock's trailing
 * tile (`router/Dock.tsx`) call this same hook rather than each keeping its
 * own copy of the per-App switch — previously `Dock.tsx`'s own
 * `useCreateAction`/`usePrimaryAction`, moved here unchanged in behavior so
 * both surfaces stay in lockstep by construction.
 *
 * `appKey` falls back to `"mail"` when it's `undefined` — Settings and a
 * placeholder App resolve to no App at all (`apps.ts#appForPath` finds
 * nothing for `/settings`), and the header still needs *something* primary
 * to render there rather than nothing: the same "show Mail's own controls
 * anyway" default `router/Dock.tsx` already takes for its own fallback
 * `app`. `ctx` in that case is `RootLayout.tsx`'s own `fallbackCtx`, whose
 * `onCompose` navigates to Mail first before composing.
 *
 * Each non-Mail case reuses that App's own existing creation entry point
 * rather than inventing a second one — see `router/Dock.tsx`'s own former
 * doc comment (now here) for why each of these is what it is:
 *  - **Contacts**: `/contacts/new` — the grid's own "New contact" screen.
 *  - **Calendar**: `openCreatePanel`, anchored to the pressed button itself
 *    (`elementAnchorRect`), defaulted to a one-hour Event starting next on
 *    the hour on the User's own default Calendar (`defaultCalendarId`) —
 *    there is no clicked grid cell here to read a time or a Calendar from.
 *  - **Tasks**: navigates to `/tasks?view=today` — `TaskTodayView.tsx`'s own
 *    quick add, the one existing "create a Task with no List picked first"
 *    entry point. TODO(#322): once the Tasks main pane's focus registry
 *    lands, this should focus the current view's quick-add row instead of
 *    navigating (the spec's own "Resolved details" → "Primary action
 *    placement" section) — that registry is #322's job, not this ticket's.
 *  - **Notes**: mints an id, writes the empty row (`createNote`, the same
 *    way `createNoteFromThreadLink` already does), then opens
 *    `/notes/$noteId` — the existing Note dialog renders any real `noteId`
 *    directly, with no separate "create mode" to gate behind a route.
 */
export function usePrimaryAction(
  appKey: string | undefined,
  ctx: ActionContext,
): PrimaryAction | null {
  const navigate = rootRoute.useNavigate();
  const calendars = useCalendars() ?? [];
  const resolvedKey = appKey ?? "mail";
  const app = appDefFor(resolvedKey) ?? APPS_BY_KEY.mail;

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      switch (resolvedKey) {
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
          // TODO(#322): focus the current view's quick-add (Today when none
          // selected) instead of navigating, once the Tasks main pane wires
          // up the focus registry the spec describes. Until then this
          // matches the Dock's pre-#319 behavior.
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
    [resolvedKey, ctx, navigate, calendars],
  );

  if (!app) return null;
  return { icon: app.primaryAction.icon, label: app.primaryAction.label, onClick };
}
