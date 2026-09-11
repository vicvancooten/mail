import { describe, expect, it } from "vitest";
import { capabilitiesFromCanEdit, foldGraphCalendar, graphCalendarRowId } from "./fold.js";

describe("graphCalendarRowId", () => {
  it("keys a mirrored row on the (connectedAccountId, graphCalendarId) pair", () => {
    expect(graphCalendarRowId("acct-1", "AAMk...primary")).toBe("gcal-ms:acct-1:AAMk...primary");
  });
});

describe("capabilitiesFromCanEdit", () => {
  it("is writable, graph-grammar recurrence, historyBounded for an editable calendar", () => {
    expect(capabilitiesFromCanEdit(true)).toEqual({
      writable: true,
      historyBounded: true,
      invitesSentByUpstream: true,
      canSuppressInviteMail: false,
      recurrenceGrammar: "graph",
      perEventReminders: 1,
      attachments: false,
      conferencing: false,
    });
  });

  it("is read-only with no recurrence grammar for a shared calendar with no write access", () => {
    const capabilities = capabilitiesFromCanEdit(false);
    expect(capabilities.writable).toBe(false);
    expect(capabilities.recurrenceGrammar).toBe("none");
  });

  it("is historyBounded regardless of canEdit — Graph's own windowed-delta bend, not an access-role fact", () => {
    expect(capabilitiesFromCanEdit(false).historyBounded).toBe(true);
  });
});

describe("foldGraphCalendar", () => {
  it("folds name/hexColor/canEdit from one GET /me/calendars entry", () => {
    const folded = foldGraphCalendar({
      id: "AAMk...primary",
      name: "Calendar",
      hexColor: "FF0000",
      canEdit: true,
      changeKey: "abc123",
    });
    expect(folded.name).toBe("Calendar");
    expect(folded.color).toBe("#FF0000");
    expect(folded.capabilities.writable).toBe(true);
  });

  it("falls back to the shared default swatch when hexColor is empty", () => {
    const folded = foldGraphCalendar({
      id: "AAMk...primary",
      name: "Calendar",
      hexColor: "",
      canEdit: true,
      changeKey: "abc123",
    });
    expect(folded.color).toBe("#4285F4");
  });
});
