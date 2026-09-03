import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../store/index.js";
import { type GroupBulkController, VirtualizedThreadList } from "./VirtualizedThreadList.js";

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

beforeEach(() => {
  localStorage.clear();
});

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
    expect(
      Array.from(document.querySelectorAll(".group-header-label")).map((h) => h.textContent),
    ).toEqual(["Today", "Yesterday", "Last week", "Older"]);
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

describe("VirtualizedThreadList — the group header cluster (#66, #77)", () => {
  const NOW = new Date("2026-06-25T12:00:00.000Z");

  function makeController(overrides: Partial<GroupBulkController> = {}): GroupBulkController {
    return {
      countFor: () => null,
      requestCount: vi.fn(),
      onDoneAll: vi.fn(),
      onMarkAllRead: vi.fn(),
      clearingThreadIds: new Set(),
      ...overrides,
    };
  }

  function renderWithGroupBulk(groupBulk: GroupBulkController) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const threads = [
      makeThread("t-today-1", "2026-06-25T09:00:00.000Z"),
      makeThread("t-today-2", "2026-06-25T08:00:00.000Z"),
    ];
    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
        groupBulk={groupBulk}
      />,
    );
  }

  it("renders Done all and Mark all read as real, always-tabbable controls naming their group", () => {
    const controller = makeController();
    renderWithGroupBulk(controller);

    const doneAll = screen.getByRole("button", { name: "Done with Today" });
    const markRead = screen.getByRole("button", { name: "Mark Today read" });
    expect(doneAll).toBeDefined();
    expect(markRead).toBeDefined();

    fireEvent.click(doneAll);
    expect(controller.onDoneAll).toHaveBeenCalledWith("Today");

    fireEvent.click(markRead);
    expect(controller.onMarkAllRead).toHaveBeenCalledWith("Today");
  });

  it("arms the cluster on hover, on focus, and on tap alike — real component state, not bare :hover", () => {
    const controller = makeController();
    renderWithGroupBulk(controller);

    const cluster = document.querySelector(".group-header-cluster") as HTMLElement;
    expect(cluster.getAttribute("data-armed")).toBe("false");

    fireEvent.mouseEnter(cluster);
    expect(cluster.getAttribute("data-armed")).toBe("true");
    fireEvent.mouseLeave(cluster);
    expect(cluster.getAttribute("data-armed")).toBe("false");

    fireEvent.focus(cluster);
    expect(cluster.getAttribute("data-armed")).toBe("true");
    fireEvent.blur(cluster);
    expect(cluster.getAttribute("data-armed")).toBe("false");

    // Touch has no hover — tapping the header arms it the same way (#66's
    // own acceptance bar).
    fireEvent.click(cluster);
    expect(cluster.getAttribute("data-armed")).toBe("true");
  });

  it("shows the group's true total once resolved, not the loaded count", () => {
    const controller = makeController({ countFor: (label) => (label === "Today" ? 4200 : null) });
    renderWithGroupBulk(controller);

    // Two Threads loaded, but the true total from the Sync Backend wins.
    expect(document.querySelector(".group-header-count")?.textContent).toBe("4200");
  });

  it("falls back to the loaded count until the true count resolves", () => {
    const controller = makeController();
    renderWithGroupBulk(controller);

    expect(document.querySelector(".group-header-count")?.textContent).toBe("2");
  });

  it("requests the true count once the header is armed", () => {
    const controller = makeController();
    renderWithGroupBulk(controller);

    fireEvent.mouseEnter(document.querySelector(".group-header-cluster") as HTMLElement);
    expect(controller.requestCount).toHaveBeenCalledWith("Today");
  });

  it("hovering the header checkmark previews every row's own Done control in that group", () => {
    const controller = makeController();
    renderWithGroupBulk(controller);

    const rows = screen.getAllByRole("option");
    expect(rows.every((row) => row.getAttribute("data-group-preview") !== "true")).toBe(true);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Done with Today" }));
    expect(
      screen
        .getAllByRole("option")
        .every((row) => row.getAttribute("data-group-preview") === "true"),
    ).toBe(true);

    fireEvent.mouseLeave(screen.getByRole("button", { name: "Done with Today" }));
    expect(
      screen
        .getAllByRole("option")
        .every((row) => row.getAttribute("data-group-preview") !== "true"),
    ).toBe(true);
  });

  it("renders no Done all/Mark all read for Pinned or Undated — neither is a valid bulk-Triage target — but still offers Collapse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const pinned: CachedThread = {
      ...makeThread("t-pinned", "2026-06-25T09:00:00.000Z"),
      pinned: true,
    };
    const undated: CachedThread = {
      ...makeThread("t-undated", "2026-06-25T09:00:00.000Z"),
      lastMessageAt: null,
      firstMessageAt: null,
    };
    render(
      <VirtualizedThreadList
        threads={[pinned, undated]}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
        groupBulk={makeController()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Done with/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse Pinned" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Collapse Undated" })).toBeDefined();
  });

  it("still offers Collapse — but no Done all/Mark all read — when groupBulk is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(
      <VirtualizedThreadList
        threads={[makeThread("t1", "2026-06-25T09:00:00.000Z")]}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /Done with/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mark .* read/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse Today" })).toBeDefined();
  });

  it("marks a clearing Thread's row with its stagger index, capped at the row cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const threads = Array.from({ length: 10 }, (_, i) =>
      makeThread(`t-today-${i}`, "2026-06-25T09:00:00.000Z"),
    );
    const clearingThreadIds = new Set(threads.map((t) => t.id));
    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
        groupBulk={makeController({ clearingThreadIds })}
      />,
    );

    const rows = screen.getAllByRole("option");
    expect(rows.every((row) => row.parentElement?.getAttribute("data-clearing") === "true")).toBe(
      true,
    );
    const indices = rows.map((row) =>
      (row.parentElement as HTMLElement).style.getPropertyValue("--group-clear-index"),
    );
    expect(indices.slice(0, 8)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
    // Past the 8-row stagger cap, every remaining row shares the last index —
    // still leaving with the group's own collapse, just not its own delay.
    expect(indices.slice(8)).toEqual(["7", "7"]);
  });
});

describe("VirtualizedThreadList — collapsible groups as a Device Preference (#78)", () => {
  const NOW = new Date("2026-06-25T12:00:00.000Z");

  function renderGrouped(threads: CachedThread[]) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
      />,
    );
  }

  it("collapsing a group hides its rows but keeps the header and its count", () => {
    renderGrouped([
      makeThread("t-today-1", "2026-06-25T09:00:00.000Z"),
      makeThread("t-today-2", "2026-06-25T08:00:00.000Z"),
    ]);

    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Collapse Today" }));

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(document.querySelector(".group-header")).not.toBeNull();
    expect(document.querySelector(".group-header-count")?.textContent).toBe("2");
  });

  it("flips the control to Expand once collapsed, and back on a second tap", () => {
    renderGrouped([makeThread("t1", "2026-06-25T09:00:00.000Z")]);

    fireEvent.click(screen.getByRole("button", { name: "Collapse Today" }));
    const expandButton = screen.getByRole("button", { name: "Expand Today" });
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandButton);
    expect(screen.getByRole("button", { name: "Collapse Today" })).toBeDefined();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("persists collapsed state per device, keyed by label, across a remount — 'survives reload'", () => {
    const threads = [makeThread("t1", "2026-06-25T09:00:00.000Z")];
    renderGrouped(threads);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Today" }));
    cleanup();

    renderGrouped(threads);
    expect(screen.getByRole("button", { name: "Expand Today" })).toBeDefined();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("collapsing one group leaves a sibling group's rows untouched", () => {
    renderGrouped([
      makeThread("t-today", "2026-06-25T09:00:00.000Z"),
      makeThread("t-yesterday", "2026-06-24T09:00:00.000Z"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Collapse Today" }));

    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Collapse Yesterday" })).toBeDefined();
  });
});
