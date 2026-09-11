import type { Calendar } from "@mail/shared";
import type { CivilDate } from "./calendar-dates.js";
import { openCreatePanel, type PanelAnchorRect } from "./calendar-event-panel.js";

/** The create popover's own default destination Calendar — the current User's default, or just the first one when none is marked default. Shared by every grid's click-to-create entry point: `DayTimeGrid.tsx`'s hour rows, its all-day row, and `MonthGrid.tsx`'s day cells. */
export function defaultCalendarId(calendarById: ReadonlyMap<string, Calendar>): string | null {
  const all = [...calendarById.values()];
  return (all.find((calendar) => calendar.isDefault) ?? all[0])?.id ?? null;
}

/**
 * Opens the create popover for a whole day, no specific time (#261) — the
 * all-day row and Month's own day cells, neither of which ever names a
 * clicked time (ADR-0030: only the timed grid does). Seeded as a one-day
 * all-day Event by default, `EventEditorPopover.tsx`'s own ordinary create
 * shape; switching the popover's own Event/Task switch to Task reads this
 * same `allDay: true` to prefill Due with just this day and no time.
 */
export function openCreatePanelForDay(
  day: CivilDate,
  calendarById: ReadonlyMap<string, Calendar>,
  anchorRect: PanelAnchorRect,
): void {
  const calendarId = defaultCalendarId(calendarById);
  if (!calendarId) return;
  const start = new Date(day.year, day.month - 1, day.day, 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  openCreatePanel({
    calendarId,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: true,
    anchorRect,
  });
}
