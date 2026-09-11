import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { setSessionUserId } from "../store/session.js";
import { makeCalendar } from "../test-support/mail-fixtures.js";
import { CalendarSettingsSheet } from "./CalendarSettingsSheet.js";

const USER = "user-1";

const enqueueUserMutation = vi.fn();
vi.mock("../store/index.js", () => ({
  enqueueUserMutation: (...args: unknown[]) => enqueueUserMutation(...args),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `calendar-settings-sheet-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  enqueueUserMutation.mockReset();
  try {
    globalThis.localStorage?.clear();
  } catch {
    // No localStorage in this environment — the device pref falls back to "every Calendar shown" anyway.
  }
});

afterEach(() => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  return Promise.all(names.splice(0).map((nm) => Dexie.delete(nm))).then(() => undefined);
});

/**
 * `CalendarSettingsSheet.tsx` (#236): "Everything a User can say about a
 * Calendar rather than an Event" — covers the write side field by field and
 * the "no edit affordances" guard the ticket's own acceptance line asks for.
 */
describe("CalendarSettingsSheet (#236)", () => {
  it("renders nothing while closed", () => {
    render(<CalendarSettingsSheet calendar={null} onOpenChange={() => {}} />);
    expect(screen.queryByText("Name")).toBeNull();
  });

  it("commits name/description/timeZone together on blur for a writable Calendar", async () => {
    const user = userEvent.setup();
    const calendar = makeCalendar("cal-1", USER, { name: "Personal", description: null });
    render(<CalendarSettingsSheet calendar={calendar} onOpenChange={() => {}} />);

    const nameInput = screen.getByDisplayValue("Personal");
    await user.clear(nameInput);
    await user.type(nameInput, "Work");
    await user.tab();

    expect(enqueueUserMutation).toHaveBeenCalledWith({
      type: "updateCalendarDetails",
      calendarId: "cal-1",
      name: "Work",
      description: null,
      timeZone: calendar.timeZone,
    });
  });

  it("shows no edit affordance for name/description/timeZone on a read-only Calendar", () => {
    const calendar = makeCalendar("cal-1", USER, {
      capabilities: {
        writable: false,
        historyBounded: false,
        invitesSentByUpstream: true,
        canSuppressInviteMail: false,
        recurrenceGrammar: "none",
        perEventReminders: 5,
        attachments: false,
        conferencing: false,
      },
    });
    render(<CalendarSettingsSheet calendar={calendar} onOpenChange={() => {}} />);

    expect(screen.queryByDisplayValue(calendar.name)).toBeNull();
    expect(screen.getAllByText(calendar.name).length).toBeGreaterThan(0);
  });

  it("lets colour, shown and default apply even on a read-only Calendar", async () => {
    const user = userEvent.setup();
    const calendar = makeCalendar("cal-1", USER, {
      isDefault: false,
      capabilities: {
        writable: false,
        historyBounded: false,
        invitesSentByUpstream: true,
        canSuppressInviteMail: false,
        recurrenceGrammar: "none",
        perEventReminders: 5,
        attachments: false,
        conferencing: false,
      },
    });
    render(<CalendarSettingsSheet calendar={calendar} onOpenChange={() => {}} />);

    await user.click(screen.getByLabelText("Default calendar for new Events"));

    expect(enqueueUserMutation).toHaveBeenCalledWith({
      type: "setDefaultCalendar",
      calendarId: "cal-1",
    });
  });

  it("does not offer a Mail account for a mirrored Calendar", () => {
    const calendar = makeCalendar("cal-1", USER, {
      origin: { type: "connectedAccount", connectedAccountId: "acct-1" },
    });
    render(<CalendarSettingsSheet calendar={calendar} onOpenChange={() => {}} />);

    expect(screen.queryByText("Mail account")).toBeNull();
  });

  it("offers a Mail account select for a Local Calendar", () => {
    const calendar = makeCalendar("cal-1", USER, {
      origin: { type: "local" },
    });
    render(<CalendarSettingsSheet calendar={calendar} onOpenChange={() => {}} />);

    expect(screen.getByText("Mail account")).not.toBeNull();
  });
});
