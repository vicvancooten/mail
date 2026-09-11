import { describe, expect, it } from "vitest";
import type { CaldavCalendarEntry } from "./client.js";
import {
  caldavCalendarRowId,
  caldavHrefFromRowId,
  capabilitiesFromCaldavEntry,
  foldCaldavCalendar,
} from "./fold.js";

function entry(overrides: Partial<CaldavCalendarEntry> = {}): CaldavCalendarEntry {
  return {
    href: "https://dav.example.com/calendars/user/work/",
    displayName: "Work",
    color: "#FF0000",
    timeZone: "Europe/Amsterdam",
    ctag: "ctag-1",
    writable: true,
    invitesSentByUpstream: true,
    ...overrides,
  };
}

describe("caldavCalendarRowId / caldavHrefFromRowId", () => {
  it("round-trips the href through the deterministic row id", () => {
    const id = caldavCalendarRowId("acct-1", "https://dav.example.com/cal/work/");
    expect(id).toBe("caldav:acct-1:https://dav.example.com/cal/work/");
    expect(caldavHrefFromRowId(id, "acct-1")).toBe("https://dav.example.com/cal/work/");
  });
});

describe("capabilitiesFromCaldavEntry", () => {
  it("is writable and rfc5545 for a scheduling-aware, writable collection", () => {
    const caps = capabilitiesFromCaldavEntry(entry());
    expect(caps.writable).toBe(true);
    expect(caps.invitesSentByUpstream).toBe(true);
    expect(caps.recurrenceGrammar).toBe("rfc5545");
  });

  it("marks a self-scheduled (no calendar-auto-schedule) collection accordingly", () => {
    const caps = capabilitiesFromCaldavEntry(entry({ invitesSentByUpstream: false }));
    expect(caps.invitesSentByUpstream).toBe(false);
  });

  it("is read-only with recurrenceGrammar none when current-user-privilege-set denies write", () => {
    const caps = capabilitiesFromCaldavEntry(entry({ writable: false }));
    expect(caps.writable).toBe(false);
    expect(caps.recurrenceGrammar).toBe("none");
  });
});

describe("foldCaldavCalendar", () => {
  it("folds the PROPFIND entry into a Calendar row's own fields", () => {
    const folded = foldCaldavCalendar(entry());
    expect(folded.name).toBe("Work");
    expect(folded.timeZone).toBe("Europe/Amsterdam");
    expect(folded.color).toBe("#FF0000");
  });

  it("falls back to UTC and the default colour when the server offers neither", () => {
    const folded = foldCaldavCalendar(entry({ timeZone: null, color: null }));
    expect(folded.timeZone).toBe("UTC");
    expect(folded.color).toBe("#4285F4");
  });
});
