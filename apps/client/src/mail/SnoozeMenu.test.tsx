import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../store/index.js";
import { SnoozeMenu } from "./SnoozeMenu.js";

function makeThread(overrides: Partial<CachedThread> = {}): CachedThread {
  return {
    id: "t1",
    mailAccountId: "acct-1",
    subject: "Quarterly numbers",
    participants: [{ name: "Ada Lovelace", address: "ada@example.test" }],
    snippet: "See attached",
    lastMessageId: null,
    firstMessageAt: "2026-06-25T09:00:00.000Z",
    lastMessageAt: "2026-06-25T09:00:00.000Z",
    messageCount: 1,
    unreadCount: 0,
    starred: false,
    hasAttachments: false,
    inInbox: true,
    folderRole: "inbox",
    hasSentMessage: false,
    pinned: false,
    labelIds: [],
    gmailLabelIds: [],
    heldSender: null,
    heldRecipientAlias: null,
    snoozeUntil: null,
    updatedAt: "2026-06-25T09:00:00.000Z",
    sortKey: "2026-06-25T09:00:00.000Z|t1",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

/**
 * Region Settings (#304): the Snooze menu's own preset times and its custom
 * picker's live preview route through the same `formatSnoozeUntil`
 * (`snooze-presets.ts`) every other Mail date/time surface uses —
 * `ThreadDetailPane.test.tsx`'s own "drops AM/PM once the clock is forced to
 * 24-hour" case, applied here.
 */
describe("SnoozeMenu Region Settings (#304)", () => {
  it("reads preset times in the 12-hour clock by default", () => {
    render(
      <SnoozeMenu
        thread={makeThread()}
        onSnooze={vi.fn()}
        onClose={vi.fn()}
        region={{ locale: "en-US", clockFormat: "12", timeZone: "UTC" }}
      />,
    );

    const laterToday = screen.getByRole("menuitem", { name: /Later today/ });
    expect(laterToday.textContent).toMatch(/AM|PM/);
  });

  it("drops AM/PM from preset times once the clock is forced to 24-hour", () => {
    render(
      <SnoozeMenu
        thread={makeThread()}
        onSnooze={vi.fn()}
        onClose={vi.fn()}
        region={{ locale: "en-US", clockFormat: "24", timeZone: "UTC" }}
      />,
    );

    const laterToday = screen.getByRole("menuitem", { name: /Later today/ });
    expect(laterToday.textContent).not.toMatch(/AM|PM/);
  });

  it("previews the custom picker's parsed value in the region's clock format", async () => {
    const user = userEvent.setup();
    render(
      <SnoozeMenu
        thread={makeThread()}
        onSnooze={vi.fn()}
        onClose={vi.fn()}
        region={{ locale: "en-US", clockFormat: "24", timeZone: "UTC" }}
      />,
    );

    const input = screen.getByLabelText("Custom snooze time");
    await user.type(input, "2026-07-04T15:30");

    // `datetime-local` is parsed in the *device's* own zone, so the region's
    // forced UTC preview may read back a different clock digit — this only
    // asserts the shared formatter ran: a "Jul 4" date and a 24-hour clock
    // (no AM/PM), never the input's own un-formatted value.
    const preview = await screen.findByText(/Jul 4/);
    expect(preview.textContent).not.toMatch(/AM|PM/);
  });
});
