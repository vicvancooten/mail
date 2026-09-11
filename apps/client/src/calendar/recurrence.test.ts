import { describe, expect, it } from "vitest";
import { recurrenceTemplateFor, rrulesForTemplate, withUntil } from "./recurrence.js";

describe("recurrenceTemplateFor", () => {
  it("recognizes each of the five authored templates", () => {
    expect(recurrenceTemplateFor([])).toBe("none");
    expect(recurrenceTemplateFor(["FREQ=DAILY"])).toBe("daily");
    expect(recurrenceTemplateFor(["FREQ=WEEKLY"])).toBe("weekly");
    expect(recurrenceTemplateFor(["FREQ=MONTHLY"])).toBe("monthly");
    expect(recurrenceTemplateFor(["FREQ=YEARLY"])).toBe("yearly");
  });

  it("falls back to null (read-only) for anything untranslatable", () => {
    expect(recurrenceTemplateFor(["FREQ=WEEKLY;BYDAY=MO,WE,FR"])).toBeNull();
    expect(recurrenceTemplateFor(["FREQ=DAILY", "FREQ=WEEKLY"])).toBeNull();
    expect(recurrenceTemplateFor(["FREQ=DAILY;COUNT=5"])).toBeNull();
  });
});

describe("rrulesForTemplate", () => {
  it("round-trips through recurrenceTemplateFor for each template", () => {
    for (const template of ["none", "daily", "weekly", "monthly", "yearly"] as const) {
      expect(recurrenceTemplateFor(rrulesForTemplate(template))).toBe(template);
    }
  });

  it("none clears recurrence entirely", () => {
    expect(rrulesForTemplate("none")).toEqual([]);
  });
});

describe("withUntil", () => {
  it("appends UNTIL in RFC 5545's zoned DATE-TIME form", () => {
    const capped = withUntil(["FREQ=WEEKLY"], new Date("2026-03-01T08:59:59.000Z"), false);
    expect(capped).toEqual(["FREQ=WEEKLY;UNTIL=20260301T085959Z"]);
  });

  it("appends UNTIL in RFC 5545's DATE-only form for an all-day Series", () => {
    const capped = withUntil(["FREQ=DAILY"], new Date("2026-03-01T00:00:00.000Z"), true);
    expect(capped).toEqual(["FREQ=DAILY;UNTIL=20260301"]);
  });

  it("replaces an existing UNTIL or COUNT rather than appending a second one", () => {
    const capped = withUntil(
      ["FREQ=WEEKLY;UNTIL=20300101T000000Z", "FREQ=DAILY;COUNT=10"],
      new Date("2026-03-01T08:59:59.000Z"),
      false,
    );
    expect(capped).toEqual([
      "FREQ=WEEKLY;UNTIL=20260301T085959Z",
      "FREQ=DAILY;UNTIL=20260301T085959Z",
    ]);
  });

  it("leaves a non-recurring Series' empty rrules alone — nothing to cap", () => {
    expect(withUntil([], new Date(), false)).toEqual([]);
  });
});
