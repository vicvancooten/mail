import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readAccountScope,
  readCommandUsage,
  readGroupCollapsed,
  readTaskBoardMode,
  readTaskCompletedOpen,
  readTaskSwimlane,
  recordCommandUsage,
  resolveAccountScope,
  useListDensity,
  useSidebarCollapsed,
  useTaskBoardMode,
  useTaskCompletedOpen,
  useTaskSwimlane,
  useViewMode,
  writeAccountScope,
  writeGroupCollapsed,
  writeTaskBoardMode,
  writeTaskSwimlane,
} from "./device-preferences.js";

/**
 * Account Scope's device-preference seam (#73): the read/write pair and the
 * resolution rule `useAccountScope` builds on. `MailSection.test.tsx`
 * exercises the same behavior end to end (through the control, the merged
 * Thread list, and the notification-narrowing path); this is the narrower,
 * storage-level check.
 */

const ACCOUNTS = [{ id: "acct-1" }, { id: "acct-2" }, { id: "acct-3" }];

beforeEach(() => {
  localStorage.clear();
});

describe("resolveAccountScope", () => {
  it("defaults to every account when nothing is stored", () => {
    expect(resolveAccountScope(null, ACCOUNTS)).toEqual(["acct-1", "acct-2", "acct-3"]);
  });

  it("keeps a stored, still-valid subset — ordered by the account list, not the stored order", () => {
    expect(resolveAccountScope(["acct-3", "acct-1"], ACCOUNTS)).toEqual(["acct-1", "acct-3"]);
  });

  it("falls back to every account once a stored subset names no account that still exists", () => {
    expect(resolveAccountScope(["deleted-account"], ACCOUNTS)).toEqual([
      "acct-1",
      "acct-2",
      "acct-3",
    ]);
  });

  it("drops only the stale ids from a stored subset that's partly still valid", () => {
    expect(resolveAccountScope(["acct-2", "deleted-account"], ACCOUNTS)).toEqual(["acct-2"]);
  });
});

describe("readAccountScope / writeAccountScope", () => {
  it("round-trips a written Scope — the persistence acceptance criteria ('survives reload')", () => {
    writeAccountScope(["acct-2", "acct-3"]);
    expect(readAccountScope()).toEqual(["acct-2", "acct-3"]);
  });

  it("reads null when nothing has ever been written", () => {
    expect(readAccountScope()).toBeNull();
  });

  it("cannot be written empty — the acceptance criteria's 'cannot be emptied', enforced at the write seam too", () => {
    writeAccountScope(["acct-1"]);
    writeAccountScope([]);
    expect(readAccountScope()).toEqual(["acct-1"]);
  });

  it("reads null back from corrupt storage rather than throwing", () => {
    localStorage.setItem("mail.devicePref.accountScope", "{not json");
    expect(readAccountScope()).toBeNull();
  });
});

/**
 * Collapsed group state's device-preference seam (#78): keyed by the
 * group's own label, per the acceptance criteria's "keyed by group label" —
 * `VirtualizedThreadList.test.tsx` exercises the same behavior end to end
 * through the header cluster.
 */
describe("readGroupCollapsed / writeGroupCollapsed", () => {
  it("defaults to expanded when nothing is stored", () => {
    expect(readGroupCollapsed("Today")).toBe(false);
  });

  it("round-trips a collapsed group — persists per device and survives reload", () => {
    writeGroupCollapsed("Today", true);
    expect(readGroupCollapsed("Today")).toBe(true);
  });

  it("keys state per label — collapsing one group leaves another untouched", () => {
    writeGroupCollapsed("Today", true);
    expect(readGroupCollapsed("Yesterday")).toBe(false);
  });

  it("un-collapsing clears the stored key rather than leaving a false behind", () => {
    writeGroupCollapsed("Today", true);
    writeGroupCollapsed("Today", false);
    expect(readGroupCollapsed("Today")).toBe(false);
    expect(localStorage.getItem("mail.devicePref.groupCollapsed.Today")).toBeNull();
  });
});

/**
 * View mode, list density and sidebar-collapsed are reactive Device
 * Preferences now (#99): a write from one mounted subscriber (e.g.
 * `settings/ThisDeviceSection.tsx`) has to reach every other
 * (`mail/MailSection.tsx`, `mail/Sidebar.tsx`) without either remounting —
 * exercised here with two independent `renderHook`s of the same `use*` hook,
 * the same "two surfaces, one store" shape `theme/device-theme.ts#useAppearance`
 * already has (`MailSection.test.tsx`'s own view-mode test covers the same
 * seam end to end, through a real component rather than a bare hook).
 */
describe("useViewMode / useListDensity / useSidebarCollapsed", () => {
  it("useViewMode: a write from one subscriber reaches another instantly", () => {
    const a = renderHook(() => useViewMode());
    const b = renderHook(() => useViewMode());
    expect(a.result.current[0]).toBe("split");

    act(() => a.result.current[1]("list"));

    expect(a.result.current[0]).toBe("list");
    expect(b.result.current[0]).toBe("list");
  });

  it("useListDensity: a write from one subscriber reaches another instantly", () => {
    const a = renderHook(() => useListDensity());
    const b = renderHook(() => useListDensity());
    expect(a.result.current[0]).toBe("comfortable");

    act(() => a.result.current[1]("compact"));

    expect(a.result.current[0]).toBe("compact");
    expect(b.result.current[0]).toBe("compact");
  });

  it("useSidebarCollapsed: a write from one subscriber reaches another instantly", () => {
    const a = renderHook(() => useSidebarCollapsed());
    const b = renderHook(() => useSidebarCollapsed());
    expect(a.result.current[0]).toBe(false);

    act(() => a.result.current[1](true));

    expect(a.result.current[0]).toBe(true);
    expect(b.result.current[0]).toBe(true);
  });
});

/**
 * Palette command usage (#148): the "most-used commands" ranking behind the
 * Command Palette's empty state (`command-palette/CommandPalette.tsx`) reads
 * straight off this — the narrower, storage-level check for the same seam
 * `command-palette-integration.test.tsx`'s own empty-state tests exercise
 * end to end.
 */
describe("readCommandUsage / recordCommandUsage", () => {
  it("starts empty", () => {
    expect(readCommandUsage()).toEqual({});
  });

  it("counts a run, and every run after it", () => {
    recordCommandUsage("compose");
    recordCommandUsage("compose");
    recordCommandUsage("done");

    expect(readCommandUsage()).toEqual({ compose: 2, done: 1 });
  });

  it("ignores a corrupt stored value rather than throwing", () => {
    localStorage.setItem("mail.devicePref.commandUsage", "not json");
    expect(readCommandUsage()).toEqual({});

    localStorage.setItem("mail.devicePref.commandUsage", JSON.stringify(["array", "not", "map"]));
    expect(readCommandUsage()).toEqual({});
  });
});

/**
 * Board mode and swimlanes' own three Device Preferences (#256): keyed per
 * view id (`today`/`upcoming`/a List's own ULID) — `readTaskBoardMode`'s own
 * doc comment on why one listener `Set` per preference is still correct even
 * though the read is keyed. `TaskListView.test.tsx`'s "Board mode" describe
 * block exercises the same seam end to end, through the header toggle and
 * the swimlane select.
 */
describe("Tasks' Device Preferences (#256)", () => {
  it("readTaskBoardMode defaults to 'list', keyed independently per view id", () => {
    writeTaskBoardMode("list-1", "board");
    expect(readTaskBoardMode("list-1")).toBe("board");
    expect(readTaskBoardMode("list-2")).toBe("list");
  });

  it("useTaskBoardMode: a write from one subscriber reaches another instantly, for the same view id", () => {
    const a = renderHook(() => useTaskBoardMode("list-1"));
    const b = renderHook(() => useTaskBoardMode("list-1"));
    expect(a.result.current[0]).toBe("list");

    act(() => a.result.current[1]("board"));

    expect(a.result.current[0]).toBe("board");
    expect(b.result.current[0]).toBe("board");
  });

  it("readTaskSwimlane defaults to 'none', round-trips 'label'/'dueBucket' and ignores garbage", () => {
    expect(readTaskSwimlane("list-1")).toBe("none");
    writeTaskSwimlane("list-1", "dueBucket");
    expect(readTaskSwimlane("list-1")).toBe("dueBucket");
    localStorage.setItem("tasks.devicePref.swimlane.list-1", "not-a-real-swimlane");
    expect(readTaskSwimlane("list-1")).toBe("none");
  });

  it("useTaskSwimlane: a write from one subscriber reaches another instantly", () => {
    const a = renderHook(() => useTaskSwimlane("list-1"));
    const b = renderHook(() => useTaskSwimlane("list-1"));

    act(() => a.result.current[1]("label"));

    expect(a.result.current[0]).toBe("label");
    expect(b.result.current[0]).toBe("label");
  });

  it("readTaskCompletedOpen defaults to closed and un-opening clears the stored key, `writeGroupCollapsed`'s own shape", () => {
    expect(readTaskCompletedOpen("today")).toBe(false);
    const hook = renderHook(() => useTaskCompletedOpen("today"));
    act(() => hook.result.current[1](true));
    expect(readTaskCompletedOpen("today")).toBe(true);

    act(() => hook.result.current[1](false));
    expect(readTaskCompletedOpen("today")).toBe(false);
    expect(localStorage.getItem("tasks.devicePref.completedOpen.today")).toBeNull();
  });
});
