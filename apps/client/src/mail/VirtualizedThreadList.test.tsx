import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../store/index.js";
import { VirtualizedThreadList } from "./VirtualizedThreadList.js";

function makeThreads(count: number): CachedThread[] {
  return Array.from({ length: count }, (_, i) => {
    const lastMessageAt = new Date(
      Date.parse("2026-06-15T12:00:00.000Z") - i * 3_600_000,
    ).toISOString();
    return {
      id: `t${i}`,
      mailAccountId: "acct-1",
      subject: `Subject ${i}`,
      participants: [{ name: "Ada", address: "ada@example.test" }],
      snippet: `Snippet ${i}`,
      lastMessageId: null,
      firstMessageAt: lastMessageAt,
      lastMessageAt,
      messageCount: 1,
      unreadCount: 0,
      starred: false,
      hasAttachments: false,
      inInbox: true,
      pinned: false,
      labelIds: [],
      heldSender: null,
      updatedAt: lastMessageAt,
      sortKey: `${lastMessageAt}|t${i}`,
    };
  });
}

afterEach(() => {
  cleanup();
});

describe("VirtualizedThreadList", () => {
  it("mounts only a bounded window of rows regardless of how many Threads the page holds", () => {
    const threads = makeThreads(500);

    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
      />,
    );

    // The stubbed 600px viewport (test-support/virtualization.ts) at
    // 60px/row plus overscan mounts well under the full 500 — this is what
    // "stays smooth against the 250k corpus" (#40) rests on: the DOM never
    // grows with the page size.
    const mounted = screen.getAllByRole("option").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
  });

  it("requests a wider page once the viewport nears the bottom of an incomplete window", () => {
    const threads = makeThreads(20);
    const onLoadMore = vi.fn();

    render(
      <VirtualizedThreadList
        threads={threads}
        complete={false}
        selectedThreadId={null}
        onSelect={() => {}}
        onLoadMore={onLoadMore}
      />,
    );

    expect(onLoadMore).toHaveBeenCalled();
  });

  it("never calls onLoadMore once the window is complete", () => {
    const threads = makeThreads(20);
    const onLoadMore = vi.fn();

    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
        onLoadMore={onLoadMore}
      />,
    );

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("renders the empty state when the account has nothing cached yet", () => {
    render(
      <VirtualizedThreadList
        threads={[]}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText("No mail cached for this account yet.")).toBeDefined();
  });
});
