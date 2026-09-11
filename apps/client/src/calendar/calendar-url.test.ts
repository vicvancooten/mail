import { describe, expect, it } from "vitest";
import { dayKey } from "./calendar-dates.js";
import {
  calendarSearchFor,
  DEFAULT_CALENDAR_VIEW,
  daysForView,
  resolveCalendarDate,
  resolveCalendarView,
  stepDate,
  validateCalendarSearch,
} from "./calendar-url.js";

const DATE = { year: 2026, month: 9, day: 8 } as const; // a Tuesday

describe("calendar-url (#231)", () => {
  it("validateCalendarSearch keeps a recognized view/date pair", () => {
    expect(validateCalendarSearch({ view: "month", date: "2026-09-08" })).toEqual({
      view: "month",
      date: "2026-09-08",
    });
  });

  it("falls back to undefined for an unrecognized view — the old-bookmark case", () => {
    expect(validateCalendarSearch({ view: "decade", date: "2026-09-08" }).view).toBeUndefined();
    expect(validateCalendarSearch({}).view).toBeUndefined();
  });

  it("resolveCalendarView/resolveCalendarDate default to Week and today", () => {
    expect(resolveCalendarView({})).toBe(DEFAULT_CALENDAR_VIEW);
    expect(resolveCalendarDate({ date: "not-a-date" })).toEqual(
      resolveCalendarDate({}), // both fall back to today()
    );
    expect(resolveCalendarDate({ date: "2026-09-08" })).toEqual(DATE);
  });

  it("daysForView hands back the right span for each view", () => {
    expect(daysForView("day", DATE)).toEqual([DATE]);
    expect(daysForView("workweek", DATE)).toHaveLength(5);
    expect(daysForView("week", DATE)).toHaveLength(7);
    expect(daysForView("month", DATE)).toHaveLength(42);
    expect(daysForView("year", DATE)).toHaveLength(365);
  });

  it("Week starts the grid on the Monday of DATE's own week", () => {
    const days = daysForView("week", DATE).map(dayKey);
    expect(days.at(0)).toBe("2026-09-07");
    expect(days.at(6)).toBe("2026-09-13");
  });

  it("Month's grid always includes the 1st and last day of the anchor month", () => {
    const days = daysForView("month", DATE);
    expect(days.some((day) => day.month === 9 && day.day === 1)).toBe(true);
    expect(days.some((day) => day.month === 9 && day.day === 30)).toBe(true);
  });

  it("stepDate moves Day/Week/Work Week by days, Month/Year by months", () => {
    expect(dayKey(stepDate("day", DATE, 1))).toBe("2026-09-09");
    expect(dayKey(stepDate("week", DATE, 1))).toBe("2026-09-15");
    expect(dayKey(stepDate("workweek", DATE, -1))).toBe("2026-09-01");
    expect(stepDate("month", DATE, 1)).toEqual({ year: 2026, month: 10, day: 8 });
    expect(stepDate("year", DATE, -1)).toEqual({ year: 2025, month: 9, day: 8 });
  });

  it("calendarSearchFor pairs a view with a date key", () => {
    expect(calendarSearchFor("month", DATE)).toEqual({ view: "month", date: "2026-09-08" });
  });
});
