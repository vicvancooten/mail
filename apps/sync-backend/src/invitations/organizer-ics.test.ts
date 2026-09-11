import { describe, expect, it } from "vitest";
import { parseIcalInvitations } from "./ical.js";
import { buildOrganizerIcs } from "./organizer-ics.js";

/** Undoes RFC 5545 line folding so a plain regex can match across what would otherwise be a wrapped continuation line. */
function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, "");
}

describe("buildOrganizerIcs", () => {
  it("builds a METHOD:REQUEST VCALENDAR the parser reads back as a request", () => {
    const ics = buildOrganizerIcs({
      method: "REQUEST",
      uid: "evt-1@wicket.test",
      sequence: 0,
      organizer: { address: "alice@example.com", name: "Alice" },
      attendees: [
        { address: "bob@example.com", name: "Bob" },
        { address: "carol@example.com", name: null },
      ],
      summary: "Weekly sync",
      description: "Catch up",
      location: "Room 1",
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      allDay: false,
      floating: false,
      tzid: null,
      rrules: [],
      rdates: [],
      exdates: [],
      recurrenceId: null,
    });

    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("UID:evt-1@wicket.test");
    expect(ics).toContain("SEQUENCE:0");
    expect(ics).toContain("ORGANIZER;CN=Alice:mailto:alice@example.com");
    const flat = unfold(ics);
    expect(flat).toMatch(/ATTENDEE;.*RSVP=TRUE.*:mailto:bob@example\.com/);
    expect(flat).toMatch(/ATTENDEE;.*RSVP=TRUE.*:mailto:carol@example\.com/);
    expect(ics).toContain("SUMMARY:Weekly sync");
    expect(ics).toContain("LOCATION:Room 1");

    const [parsed] = parseIcalInvitations(ics);
    expect(parsed?.method).toBe("REQUEST");
    expect(parsed?.uid).toBe("evt-1@wicket.test");
    expect(parsed?.sequence).toBe(0);
    expect(parsed?.organizer).toMatchObject({ address: "alice@example.com", name: "Alice" });
    expect(parsed?.attendees).toHaveLength(2);
    expect(parsed?.vevent?.title).toBe("Weekly sync");
    expect(parsed?.vevent?.location).toBe("Room 1");
    expect(parsed?.vevent?.allDay).toBe(false);
  });

  it("builds a METHOD:CANCEL with STATUS:CANCELLED and no RSVP", () => {
    const ics = buildOrganizerIcs({
      method: "CANCEL",
      uid: "evt-2@wicket.test",
      sequence: 3,
      organizer: { address: "alice@example.com", name: null },
      attendees: [{ address: "bob@example.com", name: null }],
      summary: "Cancelled sync",
      description: null,
      location: null,
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      allDay: false,
      floating: false,
      tzid: null,
      rrules: [],
      rdates: [],
      exdates: [],
      recurrenceId: null,
    });

    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(unfold(ics)).toMatch(/ATTENDEE;.*RSVP=FALSE.*:mailto:bob@example\.com/);

    const [parsed] = parseIcalInvitations(ics);
    expect(parsed?.method).toBe("CANCEL");
    expect(parsed?.sequence).toBe(3);
  });

  it("carries a RECURRENCE-ID for a single-Occurrence cancel", () => {
    const ics = buildOrganizerIcs({
      method: "CANCEL",
      uid: "evt-3@wicket.test",
      sequence: 1,
      organizer: { address: "alice@example.com", name: null },
      attendees: [{ address: "bob@example.com", name: null }],
      summary: "Weekly sync",
      description: null,
      location: null,
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      allDay: false,
      floating: false,
      tzid: null,
      rrules: ["FREQ=WEEKLY"],
      rdates: [],
      exdates: [],
      recurrenceId: "2026-01-12T09:00:00.000Z",
    });

    expect(ics).toContain("RECURRENCE-ID");
    expect(ics).toContain("RRULE:FREQ=WEEKLY");

    const [parsed] = parseIcalInvitations(ics);
    expect(parsed?.recurrenceId).not.toBe("");
  });

  it("writes an all-day VEVENT as a DATE value with no time component", () => {
    const ics = buildOrganizerIcs({
      method: "REQUEST",
      uid: "evt-4@wicket.test",
      sequence: 0,
      organizer: { address: "alice@example.com", name: null },
      attendees: [{ address: "bob@example.com", name: null }],
      summary: "Offsite",
      description: null,
      location: null,
      dtstart: new Date("2026-02-01T00:00:00.000Z"),
      durationMs: 24 * 60 * 60 * 1000,
      allDay: true,
      floating: true,
      tzid: null,
      rrules: [],
      rdates: [],
      exdates: [],
      recurrenceId: null,
    });

    expect(ics).toContain("DTSTART;VALUE=DATE:20260201");
    expect(ics).toContain("DTEND;VALUE=DATE:20260202");

    const [parsed] = parseIcalInvitations(ics);
    expect(parsed?.vevent?.allDay).toBe(true);
  });

  it("orders VEVENT properties strictly: UID, SEQUENCE, DTSTAMP, ORGANIZER, DTSTART, DTEND, SUMMARY", () => {
    const ics = buildOrganizerIcs({
      method: "REQUEST",
      uid: "evt-5@wicket.test",
      sequence: 0,
      organizer: { address: "alice@example.com", name: null },
      attendees: [{ address: "bob@example.com", name: null }],
      summary: "Ordering check",
      description: null,
      location: null,
      dtstart: new Date("2026-01-05T09:00:00.000Z"),
      durationMs: 30 * 60 * 1000,
      allDay: false,
      floating: false,
      tzid: null,
      rrules: [],
      rdates: [],
      exdates: [],
      recurrenceId: null,
    });

    const names = ["UID", "SEQUENCE", "DTSTAMP", "ORGANIZER", "DTSTART", "DTEND", "SUMMARY"];
    const positions = names.map((name) => ics.indexOf(`${name}`));
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1] as number);
    }
  });
});
