import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeCalendar } from "../test-support/mail-fixtures.js";
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
