import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCalendar } from "../test-support/mail-fixtures.js";
import { readCalendars } from "./calendars.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { setSessionUserId } from "./session.js";

let counter = 0;
const names: string[] = [];
const USER = "user-1";

beforeEach(async () => {
  const name = `calendars-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  localCache().close();
  setSessionUserId(null);
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/**
 * `readCalendars`'s sort (#236's own acceptance line: "The Calendar list
 * sorts Origin then name") — Local first, then each Connected Account's own
 * Calendars grouped together, name breaking ties within a group.
 */
describe("readCalendars — Origin then name (#236)", () => {
  it("sorts Local Calendars before any Connected Account's, alphabetically within each", async () => {
    await localCache().calendars.bulkPut([
      makeCalendar("local-b", USER, { name: "Zeta" }),
      makeCalendar("local-a", USER, { name: "Alpha" }),
      makeCalendar("gcal-b", USER, {
        name: "Beta",
        origin: { type: "connectedAccount", connectedAccountId: "acct-1" },
        isDefault: false,
      }),
      makeCalendar("gcal-a", USER, {
        name: "Alpha",
        origin: { type: "connectedAccount", connectedAccountId: "acct-1" },
        isDefault: false,
      }),
    ]);

    const calendars = await readCalendars();

    expect(calendars.map((calendar) => calendar.id)).toEqual([
      "local-a",
      "local-b",
      "gcal-a",
      "gcal-b",
    ]);
  });

  it("groups each Connected Account's Calendars together rather than interleaving by name", async () => {
    await localCache().calendars.bulkPut([
      makeCalendar("acct2-a", USER, {
        name: "Aardvark",
        origin: { type: "connectedAccount", connectedAccountId: "acct-2" },
        isDefault: false,
      }),
      makeCalendar("acct1-z", USER, {
        name: "Zebra",
        origin: { type: "connectedAccount", connectedAccountId: "acct-1" },
        isDefault: false,
      }),
      makeCalendar("acct1-a", USER, {
        name: "Aardvark",
        origin: { type: "connectedAccount", connectedAccountId: "acct-1" },
        isDefault: false,
      }),
    ]);

    const calendars = await readCalendars();

    expect(calendars.map((calendar) => calendar.id)).toEqual(["acct1-a", "acct1-z", "acct2-a"]);
  });

  it("returns nothing for a signed-out session", async () => {
    await localCache().calendars.bulkPut([makeCalendar("local-a", USER)]);
    setSessionUserId(null);

    expect(await readCalendars()).toEqual([]);
  });
});
