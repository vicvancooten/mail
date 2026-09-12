import { describe, expect, it } from "vitest";
import { makeCalendar, makeConnectedAccount } from "../test-support/mail-fixtures.js";
import { groupCalendarsByAccount } from "./calendar-groups.js";

const USER = "user-1";

/**
 * `groupCalendarsByAccount` (#300): the Calendar list's own grouping — Local
 * first, then one group per Connected Account with its Provider carried
 * along for the slide-over's badge.
 */
describe("groupCalendarsByAccount", () => {
  it("groups Local Calendars first, then each Connected Account's own", () => {
    const local = makeCalendar("cal-local", USER, { name: "Personal" });
    const googleCal = makeCalendar("cal-google", USER, {
      name: "Work",
      origin: { type: "connectedAccount", connectedAccountId: "acct-google" },
      isDefault: false,
    });
    const msCal = makeCalendar("cal-ms", USER, {
      name: "Team",
      origin: { type: "connectedAccount", connectedAccountId: "acct-ms" },
      isDefault: false,
    });
    const connectedAccounts = [
      makeConnectedAccount("acct-google", { provider: "google", identity: "ada@gmail.test" }),
      makeConnectedAccount("acct-ms", { provider: "microsoft", identity: "ada@outlook.test" }),
    ];

    const groups = groupCalendarsByAccount([local, googleCal, msCal], connectedAccounts);

    expect(groups.map((group) => group.key)).toEqual(["local", "acct-google", "acct-ms"]);
    expect(groups[0]).toMatchObject({ label: "Local", provider: null });
    expect(groups[0]?.calendars.map((c) => c.id)).toEqual(["cal-local"]);
    expect(groups[1]).toMatchObject({ label: "ada@gmail.test", provider: "google" });
    expect(groups[1]?.calendars.map((c) => c.id)).toEqual(["cal-google"]);
    expect(groups[2]).toMatchObject({ label: "ada@outlook.test", provider: "microsoft" });
  });

  it("puts every mirrored Calendar of the same Connected Account under one group", () => {
    const first = makeCalendar("cal-a", USER, {
      name: "Aardvark",
      origin: { type: "connectedAccount", connectedAccountId: "acct-1" },
      isDefault: false,
    });
    const second = makeCalendar("cal-b", USER, {
      name: "Zebra",
      origin: { type: "connectedAccount", connectedAccountId: "acct-1" },
      isDefault: false,
    });
    const connectedAccounts = [makeConnectedAccount("acct-1")];

    const groups = groupCalendarsByAccount([first, second], connectedAccounts);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.calendars.map((c) => c.id)).toEqual(["cal-a", "cal-b"]);
  });

  it("emits no group at all for an empty Calendar list", () => {
    expect(groupCalendarsByAccount([], [])).toEqual([]);
  });

  it("labels a Calendar whose Connected Account is missing by its own id rather than dropping it", () => {
    const orphan = makeCalendar("cal-orphan", USER, {
      name: "Orphan",
      origin: { type: "connectedAccount", connectedAccountId: "acct-gone" },
      isDefault: false,
    });

    const groups = groupCalendarsByAccount([orphan], []);

    expect(groups).toEqual([
      { key: "acct-gone", label: "acct-gone", provider: null, calendars: [orphan] },
    ]);
  });
});
