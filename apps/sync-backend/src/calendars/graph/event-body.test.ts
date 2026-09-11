import { describe, expect, it } from "vitest";
import {
  buildGraphEventBody,
  GraphRecurrenceUntranslatableError,
  type SeriesForGraphBody,
  toGraphRecurrence,
} from "./event-body.js";

function series(overrides: Partial<SeriesForGraphBody> = {}): SeriesForGraphBody {
  return {
    title: "Standup",
    description: null,
    location: null,
    allDay: false,
    floating: false,
    tzid: "Europe/Amsterdam",
    dtstart: new Date("2026-01-05T09:00:00Z"), // a Monday
    durationMs: 30 * 60 * 1000,
    rrules: [],
    rdates: [],
    exdates: [],
    transparency: "opaque",
    attendees: [],
    reminders: [],
    ...overrides,
  };
}

describe("toGraphRecurrence", () => {
  it("returns undefined for a non-recurring Series", () => {
    expect(toGraphRecurrence(series())).toBeUndefined();
  });

  it("translates FREQ=DAILY into a daily pattern with no end", () => {
    const recurrence = toGraphRecurrence(series({ rrules: ["FREQ=DAILY"] }));
    expect(recurrence).toEqual({
      pattern: { type: "daily", interval: 1 },
      range: { type: "noEnd", startDate: "2026-01-05" },
    });
  });

  it("translates FREQ=WEEKLY onto the dtstart's own weekday", () => {
    const recurrence = toGraphRecurrence(series({ rrules: ["FREQ=WEEKLY"] }));
    expect(recurrence?.pattern).toEqual({
      type: "weekly",
      interval: 1,
      daysOfWeek: ["monday"],
      firstDayOfWeek: "sunday",
    });
  });

  it("translates FREQ=MONTHLY onto the dtstart's own day of month", () => {
    const recurrence = toGraphRecurrence(series({ rrules: ["FREQ=MONTHLY"] }));
    expect(recurrence?.pattern).toEqual({ type: "absoluteMonthly", interval: 1, dayOfMonth: 5 });
  });

  it("translates FREQ=YEARLY onto the dtstart's own day and month", () => {
    const recurrence = toGraphRecurrence(series({ rrules: ["FREQ=YEARLY"] }));
    expect(recurrence?.pattern).toEqual({
      type: "absoluteYearly",
      interval: 1,
      dayOfMonth: 5,
      month: 1,
    });
  });

  it("translates a capped UNTIL into an endDate range", () => {
    const recurrence = toGraphRecurrence(
      series({ rrules: ["FREQ=WEEKLY;UNTIL=20260301T090000Z"] }),
    );
    expect(recurrence?.range).toEqual({
      type: "endDate",
      startDate: "2026-01-05",
      endDate: "2026-03-01",
      recurrenceTimeZone: "Europe/Amsterdam",
    });
  });

  it("throws for more than one RRULE", () => {
    expect(() => toGraphRecurrence(series({ rrules: ["FREQ=DAILY", "FREQ=WEEKLY"] }))).toThrow(
      GraphRecurrenceUntranslatableError,
    );
  });

  it("throws for a non-1 INTERVAL the editor never authors", () => {
    expect(() => toGraphRecurrence(series({ rrules: ["FREQ=DAILY;INTERVAL=2"] }))).toThrow(
      GraphRecurrenceUntranslatableError,
    );
  });

  it("throws for a BYDAY the editor never authors", () => {
    expect(() => toGraphRecurrence(series({ rrules: ["FREQ=WEEKLY;BYDAY=MO,WE"] }))).toThrow(
      GraphRecurrenceUntranslatableError,
    );
  });

  it("throws for a cancelled instance (EXDATE) — Graph's grammar has no per-date exclusion", () => {
    expect(() =>
      toGraphRecurrence(series({ rrules: ["FREQ=DAILY"], exdates: ["20260106T090000Z"] })),
    ).toThrow(GraphRecurrenceUntranslatableError);
  });

  it("throws for an added instance (RDATE) with no Graph equivalent", () => {
    expect(() =>
      toGraphRecurrence(series({ rrules: ["FREQ=DAILY"], rdates: ["20260107T090000Z"] })),
    ).toThrow(GraphRecurrenceUntranslatableError);
  });
});

describe("buildGraphEventBody", () => {
  it("carries subject/location/start/end/showAs across", () => {
    const body = buildGraphEventBody(series({ title: "1:1", location: "Room 4" }));
    expect(body.subject).toBe("1:1");
    expect(body.location).toEqual({ displayName: "Room 4" });
    expect(body.showAs).toBe("busy");
    expect(body.start?.timeZone).toBe("Europe/Amsterdam");
    expect(body.end?.timeZone).toBe("Europe/Amsterdam");
  });

  it("marks a transparent Series as free", () => {
    const body = buildGraphEventBody(series({ transparency: "transparent" }));
    expect(body.showAs).toBe("free");
  });

  it("maps attendees onto emailAddress objects", () => {
    const body = buildGraphEventBody(
      series({
        attendees: [{ email: "a@example.com", name: "A", responseStatus: "needsAction" }],
      }),
    );
    expect(body.attendees).toEqual([{ emailAddress: { address: "a@example.com", name: "A" } }]);
  });

  it("writes an all-day event as midnight UTC with isAllDay set", () => {
    const body = buildGraphEventBody(
      series({ allDay: true, tzid: null, dtstart: new Date("2026-01-05T00:00:00Z") }),
    );
    expect(body.isAllDay).toBe(true);
    expect(body.start?.dateTime.startsWith("2026-01-05T00:00:00")).toBe(true);
    expect(body.start?.timeZone).toBe("UTC");
  });
});

describe('buildGraphEventBody\'s reminders (#244, ADR-0028: "Graph: one")', () => {
  it("turns the reminder off when the Series has no explicit Reminders — Graph has no calendar-level default", () => {
    const body = buildGraphEventBody(series());
    expect(body.isReminderOn).toBe(false);
    expect(body.reminderMinutesBeforeStart).toBeUndefined();
  });

  it("takes only the first visible (relative, popup) Reminder — Graph's one slot", () => {
    const body = buildGraphEventBody(
      series({
        reminders: [
          { kind: "relative", method: "popup", minutesBefore: 10 },
          { kind: "relative", method: "popup", minutesBefore: 30 },
        ],
      }),
    );
    expect(body.isReminderOn).toBe(true);
    expect(body.reminderMinutesBeforeStart).toBe(10);
  });

  it("skips an email Reminder — Graph's reminder has no method of its own", () => {
    const body = buildGraphEventBody(
      series({ reminders: [{ kind: "relative", method: "email", minutesBefore: 15 }] }),
    );
    expect(body.isReminderOn).toBe(false);
  });
});
