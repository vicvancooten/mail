import { describe, expect, it } from "vitest";
import { parseIcalInvitations } from "./ical.js";
import { buildReplyIcs } from "./reply-ics.js";

describe("buildReplyIcs", () => {
  it("builds a METHOD:REPLY VCALENDAR the parser reads back as an answer", () => {
    const ics = buildReplyIcs({
      uid: "evt-1@example.com",
      sequence: 2,
      organizer: { address: "alice@example.com", name: "Alice", role: null, partstat: null },
      attendeeAddress: "bob+alias@example.com",
      attendeeName: "Bob",
      responseStatus: "accepted",
      summary: "Weekly sync",
    });

    expect(ics).toContain("METHOD:REPLY");
    expect(ics).toContain("UID:evt-1@example.com");
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("ORGANIZER;CN=Alice:mailto:alice@example.com");
    expect(ics).toMatch(/ATTENDEE;.*PARTSTAT=ACCEPTED.*:mailto:bob\+alias@example\.com/);

    const [parsed] = parseIcalInvitations(ics);
    expect(parsed?.method).toBe("REPLY");
    expect(parsed?.uid).toBe("evt-1@example.com");
    expect(parsed?.sequence).toBe(2);
    expect(parsed?.attendees).toEqual([
      { address: "bob+alias@example.com", name: "Bob", role: null, partstat: "ACCEPTED" },
    ]);
  });

  it("maps declined and tentative to their own PARTSTAT", () => {
    const declined = buildReplyIcs({
      uid: "u",
      sequence: 0,
      organizer: null,
      attendeeAddress: "a@example.com",
      attendeeName: null,
      responseStatus: "declined",
      summary: null,
    });
    expect(declined).toContain("PARTSTAT=DECLINED");
    expect(declined).not.toContain("ORGANIZER");

    const tentative = buildReplyIcs({
      uid: "u",
      sequence: 0,
      organizer: null,
      attendeeAddress: "a@example.com",
      attendeeName: null,
      responseStatus: "tentative",
      summary: null,
    });
    expect(tentative).toContain("PARTSTAT=TENTATIVE");
  });
});
