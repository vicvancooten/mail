import { describe, expect, it } from "vitest";
import { defaultSwipeSnoozeUntil, SNOOZE_PRESETS } from "./snooze-presets.js";

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

describe("defaultSwipeSnoozeUntil", () => {
  it("matches the first preset ('Later today')", () => {
    const now = new Date("2026-06-15T20:00:00.000Z");
    expect(defaultSwipeSnoozeUntil(now).toISOString()).toBe(
      SNOOZE_PRESETS[0]?.until(now).toISOString(),
    );
  });
});
