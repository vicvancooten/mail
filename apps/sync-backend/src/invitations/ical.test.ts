import { describe, expect, it } from "vitest";
import { mapMethodToKind, type ParsedInvitation, parseIcalInvitations } from "./ical.js";

function expectOne(ics: string): ParsedInvitation {
  const [invitation] = parseIcalInvitations(ics);
  if (!invitation) throw new Error("expected exactly one parsed Invitation");
  return invitation;
}

const REQUEST_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:evt-1@example.com",
  "DTSTAMP:20260101T120000Z",
  "DTSTART;TZID=Europe/Amsterdam:20260105T140000",
  "DTEND;TZID=Europe/Amsterdam:20260105T150000",
  "SEQUENCE:2",
  "SUMMARY:Weekly sync",
  "LOCATION:Room 1",
  "DESCRIPTION:Let's sync up",
  "ORGANIZER;CN=Alice:mailto:alice@example.com",
  "ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcalInvitations", () => {
  it("parses a REQUEST's VEVENT into a full Invitation", () => {
    const invitation = expectOne(REQUEST_ICS);
    expect(invitation.method).toBe("REQUEST");
    expect(invitation.uid).toBe("evt-1@example.com");
    expect(invitation.recurrenceId).toBe("");
    expect(invitation.sequence).toBe(2);
    expect(invitation.dtstamp.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(invitation.organizer).toEqual({
      address: "alice@example.com",
      name: "Alice",
      role: null,
      partstat: null,
    });
    expect(invitation.attendees).toEqual([
      {
        address: "bob@example.com",
        name: "Bob",
        role: "REQ-PARTICIPANT",
        partstat: "NEEDS-ACTION",
      },
    ]);
    expect(invitation.vevent).toEqual({
      title: "Weekly sync",
      description: "Let's sync up",
      location: "Room 1",
      // Amsterdam is UTC+1 in January.
      start: "2026-01-05T13:00:00.000Z",
      end: "2026-01-05T14:00:00.000Z",
      allDay: false,
      tzid: "Europe/Amsterdam",
      status: null,
    });
  });

  it("carries RECURRENCE-ID for one Occurrence's own revision", () => {
    const ics = REQUEST_ICS.replace(
      "DTSTAMP:20260101T120000Z",
      "DTSTAMP:20260101T120000Z\r\nRECURRENCE-ID:20260112T140000Z",
    );
    const invitation = expectOne(ics);
    expect(invitation.recurrenceId).toBe("2026-01-12T14:00:00.000Z");
  });

  it("maps METHOD:REPLY to kind 'answer' and METHOD:CANCEL to 'cancellation'", () => {
    expect(mapMethodToKind("REQUEST")).toBe("request");
    expect(mapMethodToKind("REPLY")).toBe("answer");
    expect(mapMethodToKind("CANCEL")).toBe("cancellation");
  });

  it("does not store an unsupported iTIP METHOD (this ticket's own scope decision)", () => {
    expect(mapMethodToKind("COUNTER")).toBeNull();
    expect(mapMethodToKind("PUBLISH")).toBeNull();
    const published = REQUEST_ICS.replace("METHOD:REQUEST", "METHOD:PUBLISH");
    expect(parseIcalInvitations(published)).toEqual([]);
  });

  it("degrades to no Invitation found for malformed input, never throwing", () => {
    expect(() => parseIcalInvitations("not an ics file at all")).not.toThrow();
    expect(parseIcalInvitations("not an ics file at all")).toEqual([]);
    expect(parseIcalInvitations("")).toEqual([]);
  });

  it("finds no Invitation in a VCALENDAR with no METHOD", () => {
    const noMethod = REQUEST_ICS.replace("METHOD:REQUEST\r\n", "");
    expect(parseIcalInvitations(noMethod)).toEqual([]);
  });

  it("reads an all-day VEVENT's DATE-valued DTSTART as allDay with no tzid", () => {
    const allDay = REQUEST_ICS.replace(
      "DTSTART;TZID=Europe/Amsterdam:20260105T140000",
      "DTSTART;VALUE=DATE:20260105",
    ).replace("DTEND;TZID=Europe/Amsterdam:20260105T150000", "DTEND;VALUE=DATE:20260106");
    const invitation = expectOne(allDay);
    expect(invitation.vevent.allDay).toBe(true);
    expect(invitation.vevent.tzid).toBeNull();
  });

  it("a REPLY's VEVENT carries only the replying Attendee, with their PARTSTAT", () => {
    const reply = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REPLY",
      "BEGIN:VEVENT",
      "UID:evt-1@example.com",
      "DTSTAMP:20260102T090000Z",
      "SEQUENCE:2",
      "ORGANIZER:mailto:alice@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const invitation = expectOne(reply);
    expect(invitation.method).toBe("REPLY");
    expect(invitation.attendees).toEqual([
      { address: "bob@example.com", name: null, role: null, partstat: "ACCEPTED" },
    ]);
  });
});
