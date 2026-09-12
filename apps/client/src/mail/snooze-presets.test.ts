import { describe, expect, it } from "vitest";
import { formatSnoozeUntil, SNOOZE_PRESETS } from "./snooze-presets.js";

describe("SNOOZE_PRESETS", () => {
  it("computes 'Later today' as 3 hours from now, whatever the calendar day", () => {
    const now = new Date("2026-06-15T20:00:00.000Z");
    const preset = SNOOZE_PRESETS.find((p) => p.label === "Later today");
    expect(preset?.until(now).toISOString()).toBe("2026-06-15T23:00:00.000Z");
  });

  it("computes 'Tomorrow' as the next calendar day at 8am local", () => {
    const now = new Date(2026, 5, 15, 14, 30, 0); // local time, mid-afternoon
    const preset = SNOOZE_PRESETS.find((p) => p.label === "Tomorrow");
    const until = preset?.until(now);
    expect(until?.getDate()).toBe(16);
    expect(until?.getHours()).toBe(8);
    expect(until?.getMinutes()).toBe(0);
  });

  it("computes 'Next week' as the next Monday at 8am local, at least a day out even on a Monday", () => {
    const monday = new Date(2026, 5, 15, 9, 0, 0); // 2026-06-15 is a Monday
    const preset = SNOOZE_PRESETS.find((p) => p.label === "Next week");
    const until = preset?.until(monday);
    expect(until?.getDay()).toBe(1); // Monday
    expect(until?.getDate()).toBe(22); // the *following* Monday, not today
    expect(until?.getHours()).toBe(8);
  });

  it("every preset resolves strictly after now", () => {
    const now = new Date();
    for (const preset of SNOOZE_PRESETS) {
      expect(preset.until(now).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("formatSnoozeUntil (#304, Region Settings)", () => {
  const now = new Date("2026-06-15T20:00:00.000Z");

  it("reads a same-day instant as a bare 12-hour time by default", () => {
    const until = new Date("2026-06-15T23:00:00.000Z");
    expect(
      formatSnoozeUntil(until, now, { locale: "en-US", clockFormat: "12", timeZone: "UTC" }),
    ).toBe("11:00 PM");
  });

  it("drops AM/PM once the clock is forced to 24-hour", () => {
    const until = new Date("2026-06-15T23:00:00.000Z");
    expect(
      formatSnoozeUntil(until, now, { locale: "en-US", clockFormat: "24", timeZone: "UTC" }),
    ).toBe("23:00");
  });

  it("prefixes a weekday and date once the instant falls on a different day", () => {
    const until = new Date("2026-06-16T08:00:00.000Z");
    const label = formatSnoozeUntil(until, now, {
      locale: "en-US",
      clockFormat: "24",
      timeZone: "UTC",
    });
    expect(label).toBe("Tue, Jun 16, 08:00");
  });
});
