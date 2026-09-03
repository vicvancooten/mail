import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../store/index.js";
import { VirtualizedThreadList } from "./VirtualizedThreadList.js";

function makeThread(id: string, lastMessageAt: string): CachedThread {
  return {
    id,
    mailAccountId: "acct-1",
    subject: `Subject ${id}`,
    participants: [{ name: "Ada", address: "ada@example.test" }],
    snippet: `Snippet ${id}`,
    lastMessageId: null,
    firstMessageAt: lastMessageAt,
    lastMessageAt,
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
    snoozeUntil: null,
    updatedAt: lastMessageAt,
    sortKey: `${lastMessageAt}|${id}`,
  };
}

function makeThreads(count: number): CachedThread[] {
  return Array.from({ length: count }, (_, i) =>
    makeThread(
      `t${i}`,
      new Date(Date.parse("2026-06-15T12:00:00.000Z") - i * 3_600_000).toISOString(),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe("VirtualizedThreadList — the taper (#75)", () => {
  const NOW = new Date("2026-06-25T12:00:00.000Z");

  function renderTapered(density?: "comfortable" | "compact") {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const threads = [
      makeThread("t-today", "2026-06-25T09:00:00.000Z"), // Today -> T1
      makeThread("t-yesterday", "2026-06-24T09:00:00.000Z"), // Yesterday -> T2
      makeThread("t-lastweek", "2026-06-12T09:00:00.000Z"), // Last week -> T3
      makeThread("t-older", "2010-01-01T09:00:00.000Z"), // Older -> T4
    ];
    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
        density={density}
      />,
    );
  }

  it("renders groups in ladder order with four visibly distinct tiers, keyed to semantic recency", () => {
    renderTapered();

    const headers = Array.from(document.querySelectorAll(".group-header"));
    expect(headers.map((h) => h.textContent)).toEqual(["Today", "Yesterday", "Last week", "Older"]);
    expect(headers.map((h) => h.getAttribute("data-tier"))).toEqual(["1", "2", "3", "4"]);

    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.getAttribute("data-tier"))).toEqual(["1", "2", "3", "4"]);

    // The same recency always gets the same tier, and the tier drives a
    // strictly descending header/row height — the one number `taper.ts`
    // owns, applied as this element's own inline height (#75: "not
    // duplicated between code and CSS").
    const headerHeights = headers.map((h) => Number.parseInt((h as HTMLElement).style.height, 10));
    expect(headerHeights).toEqual([...headerHeights].sort((a, b) => b - a));
    expect(new Set(headerHeights).size).toBe(4);

    const rowHeights = rows.map((r) => Number.parseInt((r as HTMLElement).style.height, 10));
    expect(rowHeights).toEqual([...rowHeights].sort((a, b) => b - a));
    expect(new Set(rowHeights).size).toBe(4);
  });

  it("compact density shifts every tier by a fixed delta rather than flattening the taper", () => {
    renderTapered("compact");

    const rows = screen.getAllByRole("option");
    const rowHeights = rows.map((r) => Number.parseInt((r as HTMLElement).style.height, 10));
    // Still four distinct, descending sizes under compact — the taper
    // survives density, it doesn't collapse to one flat row height.
    expect(rowHeights).toEqual([...rowHeights].sort((a, b) => b - a));
    expect(new Set(rowHeights).size).toBe(4);
    expect(document.querySelector(".thread-list--compact")).not.toBeNull();
  });

  it("an ungrouped list (search's ranked results) carries no tier and no taper", () => {
    const threads = [makeThread("t1", "2026-06-25T09:00:00.000Z")];
    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
        group={false}
      />,
    );

    expect(document.querySelector(".group-header")).toBeNull();
    expect(screen.getByRole("option").hasAttribute("data-tier")).toBe(false);
  });

  it("stays virtualized (a bounded mount) at every tier and either density", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // A spread across every tier, still 500 Threads total.
    const threads = [
      ...Array.from({ length: 5 }, (_, i) => makeThread(`today-${i}`, "2026-06-25T09:00:00.000Z")),
      ...Array.from({ length: 495 }, (_, i) =>
        makeThread(
          `older-${i}`,
          new Date(Date.parse("2010-01-01T00:00:00.000Z") - i * 3_600_000).toISOString(),
        ),
      ),
    ];

    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
        density="compact"
      />,
    );

    const mounted = screen.getAllByRole("option").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(150);
  });
});
