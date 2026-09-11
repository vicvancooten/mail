import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  type CivilDate,
  civilDateRangeToIso,
  compareCivilDates,
  dayKey,
  dayRange,
  daysInMonth,
  formatWindowEdge,
  isoWeekday,
  isSameDay,
  parseDayKey,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from "./calendar-dates.js";

const D = (year: number, month: number, day: number): CivilDate => ({ year, month, day });

describe("calendar-dates (#231)", () => {
  it("round-trips a day key", () => {
    expect(dayKey(D(2026, 9, 8))).toBe("2026-09-08");
    expect(parseDayKey("2026-09-08")).toEqual(D(2026, 9, 8));
  });

  it("rejects a key that doesn't round-trip through a real date, an unrecognized shape, or undefined", () => {
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("not-a-date")).toBeNull();
    expect(parseDayKey(undefined)).toBeNull();
  });

  it("addDays crosses month and year boundaries", () => {
    expect(addDays(D(2026, 1, 31), 1)).toEqual(D(2026, 2, 1));
    expect(addDays(D(2026, 12, 31), 1)).toEqual(D(2027, 1, 1));
    expect(addDays(D(2026, 3, 1), -1)).toEqual(D(2026, 2, 28));
  });

  it("addMonths rolls an out-of-range day into the following month", () => {
    // Jan 31 + 1 month has no Feb 31 — JS `Date` rolls this into March
    // rather than clamping to Feb 28, which is exactly why this ticket's own
    // month-stepping (`stepDate`) only ever calls this with a `day: 1`
    // anchor in practice.
    expect(addMonths(D(2026, 1, 31), 1)).toEqual(D(2026, 3, 3));
    expect(addMonths(D(2026, 9, 1), 1)).toEqual(D(2026, 10, 1));
  });

  it("isoWeekday is Monday=0..Sunday=6", () => {
    // 2026-09-07 is a Monday.
    expect(isoWeekday(D(2026, 9, 7))).toBe(0);
    expect(isoWeekday(D(2026, 9, 13))).toBe(6);
  });

  it("startOfWeek anchors on the Monday", () => {
    expect(startOfWeek(D(2026, 9, 10))).toEqual(D(2026, 9, 7));
  });

  it("startOfMonth and startOfYear anchor on day/month 1", () => {
    expect(startOfMonth(D(2026, 9, 10))).toEqual(D(2026, 9, 1));
    expect(startOfYear(D(2026, 9, 10))).toEqual(D(2026, 1, 1));
  });

  it("daysInMonth knows about leap years", () => {
    expect(daysInMonth(D(2024, 2, 1))).toBe(29);
    expect(daysInMonth(D(2026, 2, 1))).toBe(28);
  });

  it("dayRange produces `count` consecutive days", () => {
    expect(dayRange(D(2026, 9, 7), 3).map(dayKey)).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
    ]);
  });

  it("compareCivilDates and isSameDay agree with each other", () => {
    expect(compareCivilDates(D(2026, 9, 7), D(2026, 9, 8))).toBeLessThan(0);
    expect(compareCivilDates(D(2026, 9, 8), D(2026, 9, 7))).toBeGreaterThan(0);
    expect(compareCivilDates(D(2026, 9, 8), D(2026, 9, 8))).toBe(0);
    expect(isSameDay(D(2026, 9, 8), D(2026, 9, 8))).toBe(true);
    expect(isSameDay(D(2026, 9, 8), D(2026, 9, 9))).toBe(false);
  });

  it("civilDateRangeToIso spans local midnight of the first day to local midnight after the last (#232)", () => {
    const range = civilDateRangeToIso(dayRange(D(2026, 9, 7), 3));
    expect(new Date(range.start).getTime()).toBe(new Date(2026, 8, 7).getTime());
    expect(new Date(range.end).getTime()).toBe(new Date(2026, 8, 10).getTime());
  });

  it("civilDateRangeToIso falls back to today for an empty list", () => {
    const range = civilDateRangeToIso([]);
    expect(new Date(range.end).getTime() - new Date(range.start).getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it("formatWindowEdge reads as a short month/day label", () => {
    expect(formatWindowEdge("2026-06-08T00:00:00.000Z")).toMatch(/Jun/);
  });
});
