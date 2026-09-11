import {
  addDays,
  addMonths,
  type CivilDate,
  dayKey,
  dayRange,
  parseDayKey,
  startOfMonth,
  startOfWeek,
  startOfYear,
  today,
} from "./calendar-dates.js";

/**
 * The URL is the view snapshot only (#231's acceptance line): `view` and
 * `date` are `/calendar`'s own search params, never anything that looks
 * like an entity id — restoring `/calendar?view=week&date=2026-09-08`
 * recomputes the grid from scratch rather than resolving a stored "view
 * state" row.
 */
export const CALENDAR_VIEWS = ["day", "workweek", "week", "month", "year"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const DEFAULT_CALENDAR_VIEW: CalendarView = "week";

export interface CalendarSearch {
  view?: CalendarView;
  date?: string;
}

function isCalendarView(value: unknown): value is CalendarView {
  return typeof value === "string" && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

/** `routes.tsx#calendarRoute`'s own `validateSearch` — an unrecognized `view`/`date` falls back to the default rather than failing the route match. */
export function validateCalendarSearch(search: Record<string, unknown>): CalendarSearch {
  return {
    view: isCalendarView(search.view) ? search.view : undefined,
    date: typeof search.date === "string" ? search.date : undefined,
  };
}

export function resolveCalendarView(search: CalendarSearch): CalendarView {
  return search.view ?? DEFAULT_CALENDAR_VIEW;
}

export function resolveCalendarDate(search: CalendarSearch): CivilDate {
  return parseDayKey(search.date) ?? today();
}

/** The visible date range for a view, anchored on `date` — the grid components' one source of "which days to render". */
export function daysForView(view: CalendarView, date: CivilDate): CivilDate[] {
  switch (view) {
    case "day":
      return [date];
    case "workweek":
      return dayRange(startOfWeek(date), 5);
    case "week":
      return dayRange(startOfWeek(date), 7);
    case "month": {
      // A full 6-week grid so every month reads as a stable rectangle
      // (`MonthGrid.tsx`'s own doc comment on why a short month still gets
      // leading/trailing days from its neighbours).
      const gridStart = startOfWeek(startOfMonth(date));
      return dayRange(gridStart, 42);
    }
    case "year":
      return dayRange(startOfYear(date), 365);
  }
}

/** The unit `prev`/`next` step by, per view — a Month view steps by month, everything else by its own span of days. */
export function stepDate(view: CalendarView, date: CivilDate, direction: 1 | -1): CivilDate {
  switch (view) {
    case "day":
      return addDays(date, direction);
    case "workweek":
      return addDays(date, direction * 7);
    case "week":
      return addDays(date, direction * 7);
    case "month":
      return addMonths(date, direction);
    case "year":
      return addMonths(date, direction * 12);
  }
}

/** `Link`/`navigate` target for switching view and/or date, keeping the other axis put. */
export function calendarSearchFor(view: CalendarView, date: CivilDate): CalendarSearch {
  return { view, date: dayKey(date) };
}
