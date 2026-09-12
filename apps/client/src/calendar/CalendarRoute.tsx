import { Outlet } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { useHiddenCalendarIds, useShowTasksOnGrid } from "../mail/device-preferences.js";
import { deriveCalendarScope, useAccountScope } from "../mail/useAccountScope.js";
import { calendarRoute } from "../router/routes.js";
import { useCalendars } from "../store/calendars.js";
import { useEventsForRange } from "../store/events.js";
import { useConnectedAccounts } from "../store/index.js";
import { useAllTasks } from "../store/tasks.js";
import "./calendar.css";
import { CalendarSlideOver } from "./CalendarSlideOver.js";
import { CalendarViewSwitcher } from "./CalendarViewSwitcher.js";
import {
  type CivilDate,
  civilDateRangeToIso,
  dayHeadingLabel,
  dayKey,
  formatWindowEdge,
  monthHeadingLabel,
  today,
} from "./calendar-dates.js";
import { bucketEventsByDay } from "./calendar-occurrences.js";
import { bucketTasksByDay } from "./calendar-task-occurrences.js";
import {
  type CalendarView,
  calendarSearchFor,
  daysForView,
  resolveCalendarDate,
  resolveCalendarView,
  stepDate,
} from "./calendar-url.js";
import { DayTimeGrid } from "./DayTimeGrid.js";
import { EventEditorPopover } from "./EventEditorPopover.js";
import { EventMoveScopeDialog } from "./EventMoveScopeDialog.js";
import { MonthGrid } from "./MonthGrid.js";
import { TaskPopover } from "./TaskPopover.js";
import { YearGrid } from "./YearGrid.js";

const HEADING = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function headingFor(view: CalendarView, date: CivilDate, days: readonly CivilDate[]): string {
  switch (view) {
    case "day":
      return dayHeadingLabel(date);
    case "workweek":
    case "week": {
      const first = days[0] ?? date;
      const last = days[days.length - 1] ?? date;
      return first.month === last.month
        ? `${monthHeadingLabel(first)}`
        : `${HEADING.format(new Date(first.year, first.month - 1, 1))} – ${HEADING.format(new Date(last.year, last.month - 1, 1))}`;
    }
    case "month":
      return monthHeadingLabel(date);
    case "year":
      return String(date.year);
  }
}

/**
 * `/calendar`'s own screen (#231, #232, #233): the grid Variant B settled —
 * no persistent sidebar, a compact segmented view switcher, and Day/Work
 * Week/Week/Month/Year all reading `view`/`date` off the URL
 * (`calendar-url.ts`) rather than component state, so a shared link
 * restores exactly the view it was copied from.
 *
 * Navigating outside the synced Event Window (#232) fetches that range on
 * demand (`store/events.ts#useEventsForRange`) and says so in a banner
 * naming the window's own edges, rather than silently rendering an
 * incomplete grid or inferring the edge itself. Creating and editing an
 * Event on a Local Calendar (#233) is `EventEditorPopover`'s own screen —
 * one instance mounted here, gated by `calendar-event-panel.ts`'s shared
 * state, which is what makes "one popover open at a time" true regardless
 * of which grid cell or `EventChip` opened it. An Occurrence fetched from
 * outside the window carries no pending-mutation overlay either way — it
 * never reached the Local Cache the authoring path writes through.
 *
 * Due Tasks (#260) are a read-only overlay on top of all that: a Local
 * Cache query with no request of its own (`store/tasks.ts#useAllTasks`),
 * bucketed by due day (`calendar-task-occurrences.ts`) the same shape
 * `bucketEventsByDay` already gives Events, gated on the slide-over's
 * "Tasks" row (`mail/device-preferences.ts#useShowTasksOnGrid`) and never
 * handed to `YearGrid` at all — Year shows no Tasks (this ticket's own
 * acceptance line).
 *
 * Account Scope narrows the grid (#300): the Hub's Scope, narrowed to one or
 * more Connected Accounts, narrows Events to those accounts' Calendars plus
 * Local ones (`mail/useAccountScope.ts#deriveCalendarScope`) — on top of,
 * not instead of, the per-device hidden-Calendar filter above.
 */
export function CalendarRoute() {
  const search = calendarRoute.useSearch();
  const navigate = calendarRoute.useNavigate();
  const view = resolveCalendarView(search);
  const date = resolveCalendarDate(search);
  const days = useMemo(() => daysForView(view, date), [view, date]);

  const calendars = useCalendars() ?? [];
  const range = useMemo(() => civilDateRangeToIso(days), [days]);
  const { events, outsideWindow, window: eventWindow } = useEventsForRange(range.start, range.end);
  const [hiddenCalendarIds, toggleCalendarVisibility] = useHiddenCalendarIds();
  const [slideOverOpen, setSlideOverOpen] = useState(false);

  // Account Scope (#300): read independently here, the same
  // `useConnectedAccounts`/`useAccountScope` pair `MailSection.tsx` reads
  // (`useAccountScope.ts`'s own doc comment) rather than through a shared
  // prop — narrowing the Hub's Scope to one Connected Account narrows the
  // grid's own Events to that account's Calendars plus Local ones
  // (`deriveCalendarScope`), while the slide-over below still lists every
  // Calendar regardless of Scope.
  const connectedAccounts = useConnectedAccounts();
  const { scope: accountScope } = useAccountScope(connectedAccounts);
  const scopedCalendarIds = useMemo(() => {
    const scoped = deriveCalendarScope(connectedAccounts, accountScope, calendars);
    return new Set(scoped.map((calendar) => calendar.id));
  }, [connectedAccounts, accountScope, calendars]);

  // Due Tasks (#260): the Local Cache directly, no request of its own — the
  // Task collection replicates whole (`store/tasks.ts#useAllTasks`'s own
  // doc comment), so there is no window to fetch on demand the way Events
  // has one. Gated on the "Tasks" row's own show/hide Device Preference;
  // `undefined` when hidden so neither grid component renders a chip.
  const [showTasks, toggleShowTasks] = useShowTasksOnGrid();
  const allTasks = useAllTasks() ?? [];
  const taskBuckets = useMemo(
    () => (showTasks ? bucketTasksByDay(allTasks) : undefined),
    [allTasks, showTasks],
  );

  const calendarById = useMemo(() => new Map(calendars.map((cal) => [cal.id, cal])), [calendars]);
  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          !hiddenCalendarIds.has(event.calendarId) && scopedCalendarIds.has(event.calendarId),
      ),
    [events, hiddenCalendarIds, scopedCalendarIds],
  );
  const buckets = useMemo(() => bucketEventsByDay(visibleEvents), [visibleEvents]);

  function goTo(nextView: CalendarView, nextDate: CivilDate) {
    void navigate({ search: calendarSearchFor(nextView, nextDate), replace: true });
  }

  return (
    <section className="calendar-app" aria-label="Calendar">
      <header className="calendar-toolbar">
        <div className="calendar-toolbar-left">
          <button
            type="button"
            className="calendar-icon-btn"
            aria-label="Show Calendars"
            onClick={() => setSlideOverOpen(true)}
          >
            <PanelLeft size={16} />
          </button>
          <button type="button" className="calendar-today-btn" onClick={() => goTo(view, today())}>
            Today
          </button>
          <div className="calendar-nav-arrows">
            <button
              type="button"
              className="calendar-icon-btn"
              aria-label="Previous"
              onClick={() => goTo(view, stepDate(view, date, -1))}
            >
              ‹
            </button>
            <button
              type="button"
              className="calendar-icon-btn"
              aria-label="Next"
              onClick={() => goTo(view, stepDate(view, date, 1))}
            >
              ›
            </button>
          </div>
          <h2 className="calendar-heading">{headingFor(view, date, days)}</h2>
        </div>
        <CalendarViewSwitcher view={view} onChange={(nextView) => goTo(nextView, date)} />
      </header>
      {outsideWindow ? (
        <p className="calendar-window-banner" role="status">
          Showing dates outside the synced range
          {eventWindow
            ? ` (${formatWindowEdge(eventWindow.start)} – ${formatWindowEdge(eventWindow.end)})`
            : null}{" "}
          — fetched live, not offline-editable.
        </p>
      ) : null}
      <div className="calendar-body" key={`${view}-${dayKey(date)}`}>
        {view === "day" || view === "week" || view === "workweek" ? (
          <DayTimeGrid
            days={days}
            buckets={buckets}
            taskBuckets={taskBuckets}
            calendarById={calendarById}
            onOpenDay={(target) => goTo("day", target)}
          />
        ) : null}
        {view === "month" ? (
          <MonthGrid
            anchorMonth={date.month}
            days={days}
            buckets={buckets}
            taskBuckets={taskBuckets}
            calendarById={calendarById}
            onOpenDay={(target) => goTo("day", target)}
          />
        ) : null}
        {view === "year" ? (
          <YearGrid
            anchor={date}
            buckets={buckets}
            onOpenDay={(target) => goTo("day", target)}
            onOpenMonth={(target) => goTo("month", target)}
          />
        ) : null}
      </div>
      <CalendarSlideOver
        open={slideOverOpen}
        onOpenChange={setSlideOverOpen}
        calendars={calendars}
        connectedAccounts={connectedAccounts ?? []}
        hiddenCalendarIds={hiddenCalendarIds}
        onToggle={toggleCalendarVisibility}
        showTasks={showTasks}
        onToggleTasks={() => toggleShowTasks(!showTasks)}
      />
      <EventEditorPopover calendars={calendars} />
      <EventMoveScopeDialog />
      <TaskPopover
        onOpenTask={(taskId) => void navigate({ to: "/tasks/$taskId", params: { taskId } })}
      />
      <Outlet />
    </section>
  );
}
