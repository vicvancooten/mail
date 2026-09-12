import { describe, expect, it } from "vitest";
import { makeCalendar } from "../test-support/mail-fixtures.js";
import { creatableCalendars, defaultCalendarId } from "./calendar-create.js";

const USER = "user-1";

const READ_ONLY_CAPABILITIES = {
  writable: false,
  historyBounded: false,
  invitesSentByUpstream: true,
  canSuppressInviteMail: false,
  recurrenceGrammar: "none",
  perEventReminders: 5,
  attachments: false,
  conferencing: false,
} as const;

/**
 * `defaultCalendarId` (#282): the click-to-create entry point's own default
 * target Calendar never names a read-only mirror, since a Save into one
 * only ever rolls back (`sync/mutations.ts#calendar_not_writable`) — even
 * when a read-only Calendar itself carries `isDefault: true` (#236's own
 * "default applies even on a read-only Calendar" decision, `CalendarSettingsSheet.test.tsx`),
 * the click-to-create seam still has to land somewhere writable.
 */
describe("defaultCalendarId (#282)", () => {
  it("picks the isDefault Calendar when it is writable", () => {
    const calendarById = new Map([
      ["cal-1", makeCalendar("cal-1", USER, { isDefault: false })],
      ["cal-2", makeCalendar("cal-2", USER, { isDefault: true })],
    ]);

    expect(defaultCalendarId(calendarById)).toBe("cal-2");
  });

  it("skips a read-only isDefault Calendar and falls back to a writable one", () => {
    const calendarById = new Map([
      [
        "cal-readonly",
        makeCalendar("cal-readonly", USER, {
          isDefault: true,
          capabilities: READ_ONLY_CAPABILITIES,
        }),
      ],
      ["cal-writable", makeCalendar("cal-writable", USER, { isDefault: false })],
    ]);

    expect(defaultCalendarId(calendarById)).toBe("cal-writable");
  });

  it("returns null when every Calendar is read-only", () => {
    const calendarById = new Map([
      [
        "cal-readonly",
        makeCalendar("cal-readonly", USER, { capabilities: READ_ONLY_CAPABILITIES }),
      ],
    ]);

    expect(defaultCalendarId(calendarById)).toBeNull();
  });

  it("returns null with no Calendars at all", () => {
    expect(defaultCalendarId(new Map())).toBeNull();
  });
});

describe("creatableCalendars (#282)", () => {
  it("keeps a writable Calendar and drops a read-only one", () => {
    const writable = makeCalendar("cal-writable", USER);
    const readOnly = makeCalendar("cal-readonly", USER, { capabilities: READ_ONLY_CAPABILITIES });

    expect(creatableCalendars([writable, readOnly])).toEqual([writable]);
  });
});
