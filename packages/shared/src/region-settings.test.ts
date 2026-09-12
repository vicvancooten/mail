import { describe, expect, it } from "vitest";
import {
  calendarViewSchema,
  civilInstantInZone,
  clockFormatSchema,
  DEFAULT_CALENDAR_VIEW,
  DEFAULT_CLOCK_FORMAT,
  DEFAULT_FIRST_DAY_OF_WEEK,
  firstDayOfWeekSchema,
  formatHourLabel,
  formatRegionDate,
  formatRegionTime,
  REGION_LOCALE_UNSET,
} from "./region-settings.js";

describe("region-settings schemas and defaults", () => {
  it("accepts every clock/first-day/view value and rejects anything else", () => {
    expect(clockFormatSchema.safeParse("auto").success).toBe(true);
    expect(clockFormatSchema.safeParse("12").success).toBe(true);
    expect(clockFormatSchema.safeParse("24").success).toBe(true);
    expect(clockFormatSchema.safeParse("36").success).toBe(false);

    expect(firstDayOfWeekSchema.safeParse("monday").success).toBe(true);
    expect(firstDayOfWeekSchema.safeParse("sunday").success).toBe(true);
    expect(firstDayOfWeekSchema.safeParse("tuesday").success).toBe(false);

    for (const view of ["day", "workweek", "week", "month", "year"]) {
      expect(calendarViewSchema.safeParse(view).success).toBe(true);
    }
    expect(calendarViewSchema.safeParse("agenda").success).toBe(false);
  });

  it("states the defaults this ticket calls for", () => {
    expect(DEFAULT_CLOCK_FORMAT).toBe("auto");
    expect(DEFAULT_FIRST_DAY_OF_WEEK).toBe("monday");
    expect(DEFAULT_CALENDAR_VIEW).toBe("week");
    expect(REGION_LOCALE_UNSET).toBe("");
  });
});

describe("civilInstantInZone", () => {
  it("reads the same instant differently in two zones", () => {
    // 2024-01-01T00:30:00Z is already Jan 1 in Tokyo (UTC+9) but still Dec 31
    // in Los Angeles (UTC-8) — the whole point of formatting per zone rather
    // than the device's own local getters.
    const iso = "2024-01-01T00:30:00.000Z";
    expect(civilInstantInZone(iso, "Asia/Tokyo")).toEqual({
      year: 2024,
      month: 1,
      day: 1,
      hour: 9,
      minute: 30,
    });
    expect(civilInstantInZone(iso, "America/Los_Angeles")).toEqual({
      year: 2023,
      month: 12,
      day: 31,
      hour: 16,
      minute: 30,
    });
  });
});

describe("formatRegionDate / formatRegionTime", () => {
  const iso = "2024-03-15T14:05:00.000Z";

  it("honours an explicit locale and time zone for a date", () => {
    expect(
      formatRegionDate(
        iso,
        { locale: "en-US", timeZone: "America/New_York" },
        { month: "short", day: "numeric", year: undefined },
      ),
    ).toBe("Mar 15");
  });

  it("routes a forced 24-hour clock through regardless of locale", () => {
    const formatted = formatRegionTime(iso, {
      locale: "en-US",
      clockFormat: "24",
      timeZone: "UTC",
    });
    expect(formatted).toContain("14:05");
  });

  it("routes a forced 12-hour clock through regardless of locale", () => {
    const formatted = formatRegionTime(iso, {
      locale: "en-GB",
      clockFormat: "12",
      timeZone: "UTC",
    });
    expect(formatted.toUpperCase()).toContain("PM");
  });

  it("differs by time zone for the same instant", () => {
    const tokyo = formatRegionTime(iso, {
      locale: "en-US",
      clockFormat: "24",
      timeZone: "Asia/Tokyo",
    });
    const utc = formatRegionTime(iso, { locale: "en-US", clockFormat: "24", timeZone: "UTC" });
    expect(tokyo).not.toBe(utc);
  });
});

describe("formatHourLabel", () => {
  it("switches between 12- and 24-hour rails for the same hour", () => {
    expect(formatHourLabel(14, { locale: "en-US", clockFormat: "24" })).toContain("14");
    expect(formatHourLabel(14, { locale: "en-US", clockFormat: "12" }).toUpperCase()).toContain(
      "PM",
    );
  });
});
