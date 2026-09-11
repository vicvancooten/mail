import { describe, expect, it } from "vitest";
import { capabilitiesFromAccessRole, foldGoogleCalendar, googleCalendarRowId } from "./fold.js";

describe("googleCalendarRowId", () => {
  it("is deterministic and namespaced by both the account and Google's own calendar id", () => {
    expect(googleCalendarRowId("acct-1", "cal-1")).toBe("gcal:acct-1:cal-1");
    expect(googleCalendarRowId("acct-1", "cal-1")).toBe(googleCalendarRowId("acct-1", "cal-1"));
    expect(googleCalendarRowId("acct-1", "cal-1")).not.toBe(googleCalendarRowId("acct-2", "cal-1"));
  });
});

describe("capabilitiesFromAccessRole", () => {
  it("is writable with rfc5545 recurrence for owner/writer", () => {
    expect(capabilitiesFromAccessRole("owner").writable).toBe(true);
    expect(capabilitiesFromAccessRole("owner").recurrenceGrammar).toBe("rfc5545");
    expect(capabilitiesFromAccessRole("writer").writable).toBe(true);
  });

  it("is read-only with no recurrence grammar for reader/freeBusyReader", () => {
    expect(capabilitiesFromAccessRole("reader").writable).toBe(false);
    expect(capabilitiesFromAccessRole("reader").recurrenceGrammar).toBe("none");
    expect(capabilitiesFromAccessRole("freeBusyReader").writable).toBe(false);
  });

  it("caps perEventReminders at 5, the same ceiling a Local Calendar gets (#244)", () => {
    expect(capabilitiesFromAccessRole("owner").perEventReminders).toBe(5);
    expect(capabilitiesFromAccessRole("reader").perEventReminders).toBe(5);
  });
});

describe("foldGoogleCalendar", () => {
  it("prefers the CalendarList entry's own display name over the Calendars resource's", () => {
    const folded = foldGoogleCalendar(
      { id: "cal-1", accessRole: "owner", summary: "My Calendar", backgroundColor: "#abcdef" },
      { id: "cal-1", summary: "Underlying Name", timeZone: "Europe/Amsterdam" },
    );
    expect(folded.name).toBe("My Calendar");
    expect(folded.timeZone).toBe("Europe/Amsterdam");
    expect(folded.color).toBe("#abcdef");
  });

  it("falls back to the Calendars resource's summary, then the raw id, and a default color", () => {
    const folded = foldGoogleCalendar(
      { id: "cal-2", accessRole: "reader" },
      { id: "cal-2", summary: "Team Calendar", timeZone: "UTC" },
    );
    expect(folded.name).toBe("Team Calendar");
    expect(folded.color).toBe("#4285F4");

    const foldedNoSummaries = foldGoogleCalendar(
      { id: "cal-3", accessRole: "reader" },
      { id: "cal-3", timeZone: "UTC" },
    );
    expect(foldedNoSummaries.name).toBe("cal-3");
  });
});

describe("foldGoogleCalendar's reminderDefault seeding (#244, ADR-0028)", () => {
  it("seeds the timed list from Google's own defaultReminders, minutes only", () => {
    const folded = foldGoogleCalendar(
      {
        id: "cal-1",
        accessRole: "owner",
        defaultReminders: [
          { method: "popup", minutes: 30 },
          { method: "email", minutes: 1440 },
        ],
      },
      { id: "cal-1", timeZone: "UTC" },
    );
    expect(folded.reminderDefault).toEqual({ timed: [30, 1440], allDay: [] });
  });

  it("leaves both lists empty with no upstream default to seed from", () => {
    const folded = foldGoogleCalendar(
      { id: "cal-2", accessRole: "owner" },
      { id: "cal-2", timeZone: "UTC" },
    );
    expect(folded.reminderDefault).toEqual({ timed: [], allDay: [] });
  });
});
