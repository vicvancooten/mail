import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../store/index.js";
import { ThreadRow } from "./ThreadRow.js";

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
 * The row cluster's Done control (#66 user stories 8, 10, 11; #75). Every
 * assertion here is about what's observable — an accessible name, the
 * click reaching `onArchive`, the control's position relative to the
 * Avatar in the DOM — never a class name or a token.
 */
describe("ThreadRow — the Done control", () => {
  it("renders a Done control, left of the Avatar, naming the Thread it acts on", () => {
    const onArchive = vi.fn();
    render(
      <ThreadRow
        thread={makeThread()}
        selected={false}
        onSelect={() => {}}
        onArchive={onArchive}
      />,
    );

    const done = screen.getByRole("button", { name: 'Mark "Quarterly numbers" Done' });
    const avatar = document.querySelector(".mail-avatar");
    expect(avatar).not.toBeNull();
    // `compareDocumentPosition` bit 4 (DOCUMENT_POSITION_FOLLOWING) means
    // `avatar` comes after `done` in the DOM (#66 user story 11: left of,
    // never overlapping, the Avatar).
    expect(done.compareDocumentPosition(avatar as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("clicking Done calls onArchive and never selects the row", () => {
    const onArchive = vi.fn();
    const onSelect = vi.fn();
    render(
      <ThreadRow
        thread={makeThread()}
        selected={false}
        onSelect={onSelect}
        onArchive={onArchive}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: 'Mark "Quarterly numbers" Done' }));

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking anywhere else on the row still selects it", () => {
    const onSelect = vi.fn();
    render(
      <ThreadRow thread={makeThread()} selected={false} onSelect={onSelect} onArchive={() => {}} />,
    );

    fireEvent.click(screen.getByText("Quarterly numbers"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("omits the Done control when the row has no triage wired (search's non-triage caller)", () => {
    render(<ThreadRow thread={makeThread()} selected={false} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /Done/ })).toBeNull();
  });

  it("arms the cluster on hover, on focus, and when selected (j/k arrival) alike — real state, not just :hover", () => {
    const { rerender } = render(
      <ThreadRow thread={makeThread()} selected={false} onSelect={() => {}} onArchive={() => {}} />,
    );
    const row = screen.getByRole("option");
    expect(row.getAttribute("data-armed")).toBe("false");

    fireEvent.mouseEnter(row);
    expect(row.getAttribute("data-armed")).toBe("true");
    fireEvent.mouseLeave(row);
    expect(row.getAttribute("data-armed")).toBe("false");

    fireEvent.focus(screen.getByRole("button", { name: 'Mark "Quarterly numbers" Done' }));
    expect(row.getAttribute("data-armed")).toBe("true");
    fireEvent.blur(screen.getByRole("button", { name: 'Mark "Quarterly numbers" Done' }));
    expect(row.getAttribute("data-armed")).toBe("false");

    // "Arriving on a row with j/k" is `VirtualizedThreadList` setting
    // `selected` exactly the way a click does (its own doc comment) — here,
    // that's just the `selected` prop.
    rerender(
      <ThreadRow thread={makeThread()} selected={true} onSelect={() => {}} onArchive={() => {}} />,
    );
    expect(screen.getByRole("option").getAttribute("data-armed")).toBe("true");
  });

  it("the Done control keeps a real accessible name reachable by keyboard even while unarmed", () => {
    render(
      <ThreadRow thread={makeThread()} selected={false} onSelect={() => {}} onArchive={() => {}} />,
    );
    // Not hovered, not focused, not selected — still in the tab order with
    // its name, which is the whole point of "reserved space" (#66 user
    // story 56): a hover-revealed action must never be pointer-only.
    const done = screen.getByRole("button", { name: 'Mark "Quarterly numbers" Done' });
    expect(done.tabIndex).toBe(0);
  });
});

/**
 * The row cluster's Snooze control (#76): a button naming the Thread,
 * opening a small popover of presets plus a custom pick — never firing
 * `onSnooze` itself on click, unlike Done, since which time to snooze until
 * is exactly what the popover exists to ask.
 */
describe("ThreadRow — the Snooze control", () => {
  it("renders a Snooze control naming the Thread, and omits it when unwired", () => {
    render(<ThreadRow thread={makeThread()} selected={false} onSelect={() => {}} />);
    expect(screen.queryByRole("button", { name: /Snooze/ })).toBeNull();

    render(
      <ThreadRow thread={makeThread()} selected={false} onSelect={() => {}} onSnooze={() => {}} />,
    );
    expect(screen.getByRole("button", { name: 'Snooze "Quarterly numbers"' })).not.toBeNull();
  });

  it("clicking Snooze opens a popover of presets rather than snoozing directly", () => {
    const onSnooze = vi.fn();
    const onSelect = vi.fn();
    render(
      <ThreadRow thread={makeThread()} selected={false} onSelect={onSelect} onSnooze={onSnooze} />,
    );

    fireEvent.click(screen.getByRole("button", { name: 'Snooze "Quarterly numbers"' }));

    expect(onSnooze).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: 'Snooze "Quarterly numbers"' })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Later today" })).not.toBeNull();
  });

  it("picking a preset calls onSnooze with an ISO instant and closes the popover", () => {
    const onSnooze = vi.fn();
    render(
      <ThreadRow thread={makeThread()} selected={false} onSelect={() => {}} onSnooze={onSnooze} />,
    );

    fireEvent.click(screen.getByRole("button", { name: 'Snooze "Quarterly numbers"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Later today" }));

    expect(onSnooze).toHaveBeenCalledTimes(1);
    const [until] = onSnooze.mock.calls[0] as [string];
    expect(Number.isNaN(Date.parse(until))).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
