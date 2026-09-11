import type { EventReminder } from "@mail/shared";
import { describe, expect, it } from "vitest";
import { buildGoogleEventBody } from "./event-body.js";

const BASE = {
  title: "Standup",
  description: "Daily sync",
  location: "Room 4",
  durationMs: 30 * 60 * 1000,
  rrules: [] as string[],
  rdates: [] as string[],
  exdates: [] as string[],
  transparency: "opaque" as const,
  attendees: [] as { email: string; name: string | null; responseStatus: "needsAction" }[],
  reminders: [] as EventReminder[],
};

describe("buildGoogleEventBody", () => {
  it("a plain timed event carries dateTime + timeZone and no recurrence", () => {
    const body = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: false,
      tzid: "Europe/Amsterdam",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
    });

    expect(body.summary).toBe("Standup");
    expect(body.description).toBe("Daily sync");
    expect(body.location).toBe("Room 4");
    expect(body.start).toEqual({
      dateTime: "2026-01-05T09:00:00.000Z",
      timeZone: "Europe/Amsterdam",
    });
    expect(body.end).toEqual({
      dateTime: "2026-01-05T09:30:00.000Z",
      timeZone: "Europe/Amsterdam",
    });
    expect(body.recurrence).toBeUndefined();
  });

  it("a floating event carries a naive dateTime with no timeZone", () => {
    const body = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: true,
      tzid: null,
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
    });

    expect(body.start).toEqual({ dateTime: "2026-01-05T09:00:00.000" });
    expect(body.start?.timeZone).toBeUndefined();
  });

  it("an all-day event carries exclusive-end date pairs", () => {
    const body = buildGoogleEventBody({
      ...BASE,
      allDay: true,
      floating: false,
      tzid: null,
      dtstart: new Date("2026-01-05T00:00:00.000Z"),
      durationMs: 24 * 60 * 60 * 1000,
    });

    expect(body.start).toEqual({ date: "2026-01-05" });
    expect(body.end).toEqual({ date: "2026-01-06" });
  });

  it("folds rrules/rdates/exdates into RFC 5545 recurrence lines", () => {
    const body = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      rrules: ["FREQ=WEEKLY;BYDAY=MO"],
      rdates: ["20260112T090000Z"],
      exdates: ["20260119T090000Z"],
    });

    expect(body.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "RDATE:20260112T090000Z",
      "EXDATE:20260119T090000Z",
    ]);
  });

  it("maps attendees to email/displayName, omitting an empty list entirely", () => {
    const withAttendees = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      attendees: [{ email: "a@example.com", name: "Ana", responseStatus: "needsAction" }],
    });
    expect(withAttendees.attendees).toEqual([
      { email: "a@example.com", displayName: "Ana", responseStatus: "needsAction" },
    ]);

    const withoutAttendees = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
    });
    expect(withoutAttendees.attendees).toBeUndefined();
  });
});

describe("buildGoogleEventBody's reminders (#244, ADR-0028)", () => {
  it("asks for Google's own default when the Series has no explicit Reminders", () => {
    const body = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
    });
    expect(body.reminders).toEqual({ useDefault: true });
  });

  it("pushes explicit popup and email Reminders as overrides, minutes verbatim", () => {
    const body = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      reminders: [
        { kind: "relative", method: "popup", minutesBefore: 10 },
        { kind: "relative", method: "email", minutesBefore: 60 },
      ],
    });
    expect(body.reminders).toEqual({
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 10 },
        { method: "email", minutes: 60 },
      ],
    });
  });

  it("drops an absolute-time alarm — no Google representation exists for one", () => {
    const body = buildGoogleEventBody({
      ...BASE,
      allDay: false,
      floating: false,
      tzid: "UTC",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      reminders: [{ kind: "absolute", method: "popup", at: "2026-01-04T09:00:00.000Z" }],
    });
    expect(body.reminders).toEqual({ useDefault: false, overrides: [] });
  });
});
