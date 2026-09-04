import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../../store/index.js";
import { ActionMenu } from "./ActionMenu.js";
import { noopActionContext, withThread } from "./types.js";

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
 * The right-click / long-press menu (#94). Every assertion is about what a
 * User can see and reach — an item's accessible name, its keycap, the click
 * arriving at the action — never which registry entry produced it.
 */
describe("ActionMenu", () => {
  it("renders nothing of its own without a context, leaving the browser's menu alone", () => {
    render(
      <ActionMenu ctx={null} label="Actions">
        <div>row</div>
      </ActionMenu>,
    );
    expect(screen.getByText("row")).toBeDefined();
    expect(document.querySelector("[data-slot='context-menu-trigger']")).toBeNull();
  });

  it("lists the Thread's available actions with their keycaps on right-click", async () => {
    const ctx = withThread(noopActionContext(), makeThread());
    render(
      <ActionMenu ctx={ctx} label='Actions for "Quarterly numbers"'>
        <div>row</div>
      </ActionMenu>,
    );

    fireEvent.contextMenu(screen.getByText("row"));

    const done = await screen.findByRole("menuitem", { name: /Mark Done/ });
    expect(done.textContent).toContain("E");
    expect(screen.getByRole("menuitem", { name: /Move to Trash/ })).toBeDefined();
    // Nothing is loaded to reply to on a row nobody has opened, and a menu
    // never shows an unavailable action.
    expect(screen.queryByRole("menuitem", { name: "Reply" })).toBeNull();
  });

  it("runs the action the User picked", async () => {
    const archive = vi.fn();
    const base = noopActionContext();
    const ctx = withThread(
      noopActionContext({ triage: { ...base.triage, archive } }),
      makeThread(),
    );
    render(
      <ActionMenu ctx={ctx} label="Actions">
        <div>row</div>
      </ActionMenu>,
    );

    fireEvent.contextMenu(screen.getByText("row"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Mark Done/ }));

    expect(archive).toHaveBeenCalledWith("t1");
  });

  it("offers Snooze as a submenu of presets rather than a Popover a menu can't hold", async () => {
    const ctx = withThread(noopActionContext(), makeThread());
    render(
      <ActionMenu ctx={ctx} label="Actions">
        <div>row</div>
      </ActionMenu>,
    );

    fireEvent.contextMenu(screen.getByText("row"));
    const snooze = await screen.findByRole("menuitem", { name: "Snooze" });
    expect(snooze.getAttribute("aria-haspopup")).toBe("menu");
  });
});
