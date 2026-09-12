import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeCalendar, makeConnectedAccount } from "../test-support/mail-fixtures.js";
import { CalendarSlideOver } from "./CalendarSlideOver.js";

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

afterEach(() => {
  cleanup();
});

/** `CalendarSlideOver.tsx` (#282): the Calendar list's own read-only flag — the client-side half of "shown read-only in the Client". */
describe("CalendarSlideOver (#282)", () => {
  it("flags a read-only Calendar's row and leaves a writable one unflagged", () => {
    const calendars = [
      makeCalendar("cal-writable", USER, { name: "Personal" }),
      makeCalendar("cal-readonly", USER, {
        name: "Holidays",
        capabilities: READ_ONLY_CAPABILITIES,
      }),
    ];

    render(
      <CalendarSlideOver
        open
        onOpenChange={() => {}}
        calendars={calendars}
        connectedAccounts={[]}
        hiddenCalendarIds={new Set()}
        onToggle={() => {}}
        showTasks={false}
        onToggleTasks={() => {}}
      />,
    );

    const personalRow = screen.getByText("Personal").closest(".calendar-slide-over-row");
    const holidaysRow = screen.getByText("Holidays").closest(".calendar-slide-over-row");
    expect(personalRow?.querySelector('[aria-label="Read-only"]')).toBeNull();
    expect(holidaysRow?.querySelector('[aria-label="Read-only"]')).not.toBeNull();
  });
});

/** `groupCalendarsByAccount`'s render side (#300): Local first, then each Connected Account with its Provider badge. */
describe("CalendarSlideOver grouping (#300)", () => {
  it("shows a Local group first, then a Connected Account group with its provider badge", () => {
    const calendars = [
      makeCalendar("cal-local", USER, { name: "Personal" }),
      makeCalendar("cal-google", USER, {
        name: "Work",
        origin: { type: "connectedAccount", connectedAccountId: "acct-google" },
        isDefault: false,
      }),
    ];
    const connectedAccounts = [
      makeConnectedAccount("acct-google", { provider: "google", identity: "ada@gmail.test" }),
    ];

    render(
      <CalendarSlideOver
        open
        onOpenChange={() => {}}
        calendars={calendars}
        connectedAccounts={connectedAccounts}
        hiddenCalendarIds={new Set()}
        onToggle={() => {}}
        showTasks={false}
        onToggleTasks={() => {}}
      />,
    );

    const groups = document.querySelectorAll(".calendar-slide-over-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain("Local");
    expect(groups[1]?.textContent).toContain("ada@gmail.test");
    expect(groups[1]?.textContent).toContain("Google");
    expect(groups[1]?.querySelector(".calendar-slide-over-name")?.textContent).toBe("Work");
  });
});
