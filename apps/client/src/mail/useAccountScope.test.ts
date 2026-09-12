import type { Calendar, MailAccount } from "@mail/shared";
import { describe, expect, it } from "vitest";
import {
  makeCalendar,
  makeConnectedAccount,
  makeMailAccount,
} from "../test-support/mail-fixtures.js";
import { deriveCalendarScope, deriveMailAccountScope } from "./useAccountScope.js";

/**
 * `deriveMailAccountScope` (#207): what turns the Connected Account Scope
 * (`device-preferences.test.ts#resolveAccountScope` covers *that*
 * resolution) into the Mail Account ids `MailSection.tsx`/`StreamStack.tsx`
 * actually filter by — "Mail narrows by the Mail Facets in Scope, exactly
 * as it does today" (#207's acceptance criteria) made concrete.
 */

const MAIL_ACCOUNTS: MailAccount[] = [
  makeMailAccount("acct-1", { connectedAccountId: "acct-1-connected" }),
  makeMailAccount("acct-2", { connectedAccountId: "acct-2-connected" }),
];

describe("deriveMailAccountScope", () => {
  it("includes only the Mail Accounts whose Connected Account is in Scope", () => {
    expect(
      deriveMailAccountScope(
        [makeConnectedAccount("acct-1-connected"), makeConnectedAccount("acct-2-connected")],
        ["acct-1-connected"],
        MAIL_ACCOUNTS,
      ),
    ).toEqual(["acct-1"]);
  });

  it("narrows to zero Mail Accounts when Scope holds only a Connected Account with no Mail Facet — not a fallback to every account", () => {
    const calendarOnly = makeConnectedAccount("acct-3-connected", {
      facets: [{ kind: "calendar", status: "active" }],
    });
    expect(
      deriveMailAccountScope(
        [
          makeConnectedAccount("acct-1-connected"),
          makeConnectedAccount("acct-2-connected"),
          calendarOnly,
        ],
        ["acct-3-connected"],
        MAIL_ACCOUNTS,
      ),
    ).toEqual([]);
  });

  it("falls back to every Mail Account while the Connected Accounts collection hasn't synced yet", () => {
    expect(deriveMailAccountScope(undefined, [], MAIL_ACCOUNTS)).toEqual(["acct-1", "acct-2"]);
    expect(deriveMailAccountScope([], [], MAIL_ACCOUNTS)).toEqual(["acct-1", "acct-2"]);
  });
});

/**
 * `deriveCalendarScope` (#300): `deriveMailAccountScope`'s own shape for the
 * Calendar App — a Local Calendar is always in Scope, a mirrored one only
 * while its own Connected Account is checked in the Hub's picker.
 */
const CALENDARS: Calendar[] = [
  makeCalendar("cal-local", "user-1"),
  makeCalendar("cal-acct1", "user-1", {
    origin: { type: "connectedAccount", connectedAccountId: "acct-1-connected" },
    isDefault: false,
  }),
  makeCalendar("cal-acct2", "user-1", {
    origin: { type: "connectedAccount", connectedAccountId: "acct-2-connected" },
    isDefault: false,
  }),
];

describe("deriveCalendarScope", () => {
  it("keeps Local Calendars and narrows Connected Account Calendars to those in Scope", () => {
    expect(
      deriveCalendarScope(
        [makeConnectedAccount("acct-1-connected"), makeConnectedAccount("acct-2-connected")],
        ["acct-1-connected"],
        CALENDARS,
      ).map((calendar) => calendar.id),
    ).toEqual(["cal-local", "cal-acct1"]);
  });

  it("falls back to every Calendar while the Connected Accounts collection hasn't synced yet", () => {
    expect(deriveCalendarScope(undefined, [], CALENDARS).map((c) => c.id)).toEqual([
      "cal-local",
      "cal-acct1",
      "cal-acct2",
    ]);
    expect(deriveCalendarScope([], [], CALENDARS).map((c) => c.id)).toEqual([
      "cal-local",
      "cal-acct1",
      "cal-acct2",
    ]);
  });
});
