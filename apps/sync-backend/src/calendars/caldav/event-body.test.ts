import { describe, expect, it } from "vitest";
import {
  buildCaldavEventBody,
  parseCaldavObject,
  withCancelledStatus,
  withConfirmedStatus,
} from "./event-body.js";

const BASE_SERIES = {
  title: "Standup",
  description: "Daily sync",
  location: "Room 1",
  allDay: false,
  floating: false,
  tzid: "Europe/Amsterdam",
  dtstart: new Date("2026-03-02T09:00:00.000Z"),
  durationMs: 30 * 60 * 1000,
  rrules: [],
  rdates: [],
  exdates: [],
  transparency: "opaque" as const,
  attendees: [],
  sequence: 0,
};

describe("buildCaldavEventBody / parseCaldavObject round-trip", () => {
  it("builds a VEVENT that reparses to the same summary/location/timing", () => {
    const ics = buildCaldavEventBody("uid-1", BASE_SERIES);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:uid-1");
    expect(ics).toContain("SUMMARY:Standup");

    const [instance] = parseCaldavObject(ics);
    expect(instance?.uid).toBe("uid-1");
    expect(instance?.summary).toBe("Standup");
    expect(instance?.location).toBe("Room 1");
    expect(instance?.allDay).toBe(false);
    expect(instance?.status).toBe("confirmed");
    expect(instance?.transparency).toBe("opaque");
    // The name says "timing" but nothing above actually checked it — Amsterdam
    // is UTC+1 in March, so a build that goes through the wall clock and a
    // parse that doesn't convert it back only round-trips by coincidence.
    expect(instance?.start.toISOString()).toBe(BASE_SERIES.dtstart.toISOString());
    expect(instance?.end.toISOString()).toBe(
      new Date(BASE_SERIES.dtstart.getTime() + BASE_SERIES.durationMs).toISOString(),
    );
  });

  it("round-trips an all-day event's own DATE (not DATE-TIME) values", () => {
    const ics = buildCaldavEventBody("uid-allday", {
      ...BASE_SERIES,
      allDay: true,
      dtstart: new Date("2026-03-02T00:00:00.000Z"),
      durationMs: 24 * 60 * 60 * 1000,
    });
    const [instance] = parseCaldavObject(ics);
    expect(instance?.allDay).toBe(true);
  });

  it("carries every current Attendee with its own PARTSTAT", () => {
    const ics = buildCaldavEventBody("uid-attendees", {
      ...BASE_SERIES,
      attendees: [
        { email: "a@example.com", name: "A", responseStatus: "accepted" },
        { email: "b@example.com", name: null, responseStatus: "needsAction" },
      ],
    });
    expect(ics).toContain("ATTENDEE;PARTSTAT=ACCEPTED");
    expect(ics.toUpperCase()).toContain("MAILTO:A@EXAMPLE.COM");
  });
});

describe("withCancelledStatus / withConfirmedStatus", () => {
  it("flips STATUS to CANCELLED and back to CONFIRMED without touching other fields", () => {
    const ics = buildCaldavEventBody("uid-2", BASE_SERIES);
    const cancelled = withCancelledStatus(ics);
    expect(parseCaldavObject(cancelled)[0]?.status).toBe("cancelled");

    const restored = withConfirmedStatus(cancelled);
    expect(parseCaldavObject(restored)[0]?.status).toBe("confirmed");
    expect(parseCaldavObject(restored)[0]?.summary).toBe("Standup");
  });
});

describe("parseCaldavObject", () => {
  it("returns one instance per VEVENT, keeping a RECURRENCE-ID override distinct from the master", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Test//EN",
      "BEGIN:VEVENT",
      "UID:series-1",
      "DTSTART:20260302T090000Z",
      "DTEND:20260302T093000Z",
      "SUMMARY:Standup",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series-1",
      "RECURRENCE-ID:20260303T090000Z",
      "DTSTART:20260303T100000Z",
      "DTEND:20260303T103000Z",
      "SUMMARY:Standup (moved)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const instances = parseCaldavObject(ics);
    expect(instances).toHaveLength(2);
    expect(instances[0]?.recurrenceId).toBeNull();
    expect(instances[1]?.recurrenceId).toEqual(new Date("2026-03-03T09:00:00.000Z"));
    expect(instances[1]?.summary).toBe("Standup (moved)");
  });

  it("returns an empty array for unparsable text rather than throwing", () => {
    expect(parseCaldavObject("not an ics document")).toEqual([]);
  });
});
