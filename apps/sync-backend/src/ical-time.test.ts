import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { icalTimeToUtcDate } from "./ical-time.js";

function timeAt(hour: number): ICAL.Time {
  return new ICAL.Time(
    { year: 2026, month: 1, day: 5, hour, minute: 0, second: 0 },
    ICAL.Timezone.localTimezone,
  );
}

describe("icalTimeToUtcDate", () => {
  it("converts a TZID wall-clock time to its real UTC instant, not the process's local time", () => {
    // Amsterdam is UTC+1 in January, regardless of this test process's own TZ.
    const date = icalTimeToUtcDate(timeAt(14), "Europe/Amsterdam");
    expect(date.toISOString()).toBe("2026-01-05T13:00:00.000Z");
  });

  it("passes an unnamed (floating/UTC) time through to toJSDate unchanged", () => {
    const time = ICAL.Time.fromJSDate(new Date("2026-01-05T14:00:00.000Z"), true);
    const date = icalTimeToUtcDate(time, null);
    expect(date.toISOString()).toBe("2026-01-05T14:00:00.000Z");
  });

  it("falls back to toJSDate for a TZID that isn't a real IANA zone", () => {
    const time = timeAt(14);
    const date = icalTimeToUtcDate(time, "Not/AZone");
    expect(date.toISOString()).toBe(time.toJSDate().toISOString());
  });
});
