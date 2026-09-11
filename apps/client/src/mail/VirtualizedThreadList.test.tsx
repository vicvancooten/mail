import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedThread } from "../store/index.js";
import { currentListHandle, resetSurfaceHandles } from "./actions/surface-handles.js";
import { writeGroupCollapsed } from "./device-preferences.js";
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
    gmailLabelIds: [],
    heldSender: null,
    heldRecipientAlias: null,
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

/**
 * Stubs `window.matchMedia` for `useHoverCapable()` (#134): `matches`
 * answers `(hover: hover) and (pointer: fine)` — `true` simulates a
 * mouse/trackpad, `false` a touch-only pointer. Real jsdom has no
 * `matchMedia` at all (`use-mobile.ts`'s own comment), so every test that
 * never calls this keeps the hook's `true` fallback — today's
 * hover-revealed behavior, unchanged by this ticket.
 */
function stubHoverCapable(matches: boolean) {
  const mql = {
    matches,
    media: "(hover: hover) and (pointer: fine)",
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSurfaceHandles();
});

describe("VirtualizedThreadList — row gutter on input capability (#134)", () => {
  it("reserves the row's Done gutter for a hover-capable pointer, and drops it entirely for a touch-only one — never a viewport read", () => {
    stubHoverCapable(true);
    render(
      <VirtualizedThreadList
        threads={[makeThread("t1", "2026-06-25T09:00:00.000Z")]}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector(".row-check")).not.toBeNull();

    cleanup();
    stubHoverCapable(false);
    render(
      <VirtualizedThreadList
        threads={[makeThread("t1", "2026-06-25T09:00:00.000Z")]}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
      />,
    );
    expect(document.querySelector(".row-check")).toBeNull();
  });
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

  it("arms the cluster on hover and on focus alike — real component state, not bare :hover", () => {
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
  });

  it("clicking the header's own background toggles Collapse rather than the armed state (#97 bug 1)", () => {
    const controller = makeController();
    renderWithGroupBulk(controller);

    const cluster = document.querySelector(".group-header-cluster") as HTMLElement;

    // Hovering (arming) the cluster, then clicking its background — the
    // exact "checkbox jumps around" repro — must not disarm it: the click
    // is a collapse toggle, not a second `armed` trigger.
    fireEvent.mouseEnter(cluster);
    expect(cluster.getAttribute("data-armed")).toBe("true");
    fireEvent.click(cluster);
    expect(cluster.getAttribute("data-armed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand Today" })).toBeDefined();

    fireEvent.click(cluster);
    expect(screen.getByRole("button", { name: "Collapse Today" })).toBeDefined();
  });

  it("lights the header's own spine segment only on the Done-all node's hover/focus, matching every row's segment (#97 bug 2)", () => {
    const controller = makeController();
    renderWithGroupBulk(controller);

    const cluster = document.querySelector(".group-header-cluster") as HTMLElement;
    const doneAll = screen.getByRole("button", { name: "Done with Today" });

    // Hovering the header at large (its label, say) must not light the
    // spine — only the node itself previews the group.
    fireEvent.mouseEnter(cluster);
    expect(cluster.getAttribute("data-group-preview")).toBe("false");
    fireEvent.mouseLeave(cluster);

    fireEvent.mouseEnter(doneAll);
    expect(cluster.getAttribute("data-group-preview")).toBe("true");
    fireEvent.mouseLeave(doneAll);
    expect(cluster.getAttribute("data-group-preview")).toBe("false");
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

  it("a touch-only pointer's overflow button opens a Sheet offering Done all / Mark all read / Collapse, previewing the group while open (#97, #134)", () => {
    stubHoverCapable(false);
    const controller = makeController();
    renderWithGroupBulk(controller);

    const cluster = document.querySelector(".group-header-cluster") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "More actions for Today" }));

    expect(cluster.getAttribute("data-group-preview")).toBe("true");

    const sheetDoneAll = screen.getByRole("button", { name: /Done all/ });
    fireEvent.click(sheetDoneAll);
    expect(controller.onDoneAll).toHaveBeenCalledWith("Today");
    expect(cluster.getAttribute("data-group-preview")).toBe("false");
  });

  it("#134: gates the rail's Done-all node and the trailing bulk actions off on a touch-only pointer, in favor of the overflow button — never both", () => {
    stubHoverCapable(false);
    renderWithGroupBulk(makeController());

    expect(screen.queryByRole("button", { name: "Done with Today" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark Today read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse Today" })).toBeNull();
    expect(screen.getByRole("button", { name: "More actions for Today" })).toBeDefined();
  });

  it("#134: keeps the rail's Done-all node and bulk actions — never the overflow button — for a hover-capable pointer", () => {
    stubHoverCapable(true);
    renderWithGroupBulk(makeController());

    expect(screen.getByRole("button", { name: "Done with Today" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Mark Today read" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Collapse Today" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "More actions for Today" })).toBeNull();
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

describe("VirtualizedThreadList — roving tabindex and focus (#275)", () => {
  const NOW = new Date("2026-06-25T12:00:00.000Z");

  function renderRoving(selectedThreadId: string | null, onSelect = vi.fn()) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const threads = [
      makeThread("t-today", "2026-06-25T09:00:00.000Z"), // Today
      makeThread("t-yesterday", "2026-06-24T09:00:00.000Z"), // Yesterday
      makeThread("t-older", "2010-01-01T09:00:00.000Z"), // Older
    ];
    render(
      <VirtualizedThreadList
        threads={threads}
        complete={true}
        selectedThreadId={selectedThreadId}
        onSelect={onSelect}
      />,
    );
    return onSelect;
  }

  function tabIndexes() {
    return screen.getAllByRole("option").map((row) => row.tabIndex);
  }

  it("puts exactly one row in the Tab order — the selected one", () => {
    renderRoving("t-yesterday");
    expect(tabIndexes()).toEqual([-1, 0, -1]);
  });

  it("defaults the one tab stop to the first row when nothing is selected yet", () => {
    renderRoving(null);
    expect(tabIndexes()).toEqual([0, -1, -1]);
  });

  it("the published mover moves DOM focus onto the row it selects, in step with the selection", () => {
    const onSelect = renderRoving("t-today");
    currentListHandle()?.move(1);

    expect(onSelect).toHaveBeenCalledWith("t-yesterday");
    // `onSelect` doesn't itself re-render this uncontrolled harness, so the
    // row's own `tabIndex` hasn't moved — but real DOM focus, which is what
    // #275 is actually about, already has.
    expect(document.activeElement).toBe(
      screen.getByRole("option", { name: /Subject t-yesterday/ }),
    );
  });

  it("neighborOf (#275's Auto-advance seam) skips a collapsed Time Group's rows, same as the mover", () => {
    renderRoving("t-today");
    writeGroupCollapsed("Yesterday", true);
    cleanup();
    renderRoving("t-today");

    expect(currentListHandle()?.neighborOf("t-today", "older")).toBe("t-older");
    expect(currentListHandle()?.neighborOf("t-today", "newer")).toBe("t-older");
  });

  it("focusThread(null) — nothing to land on — focuses the listbox itself", () => {
    renderRoving("t-today");
    currentListHandle()?.focusThread(null);
    expect(document.activeElement).toBe(document.querySelector('[role="listbox"]'));
  });

  it("an empty list stays a focusable listbox rather than losing its own tab stop", () => {
    render(
      <VirtualizedThreadList
        threads={[]}
        complete={true}
        selectedThreadId={null}
        onSelect={() => {}}
      />,
    );
    const listbox = screen.getByRole("listbox");
    expect(listbox.tabIndex).toBe(0);
    listbox.focus();
    expect(document.activeElement).toBe(listbox);
  });
});
