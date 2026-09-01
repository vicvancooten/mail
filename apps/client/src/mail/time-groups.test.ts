import { describe, expect, it } from "vitest";
import type { CachedThread } from "../store/index.js";
import {
  formatRowTime,
  groupThreadsByTime,
  PINNED_GROUP_LABEL,
  timeGroupLabel,
} from "./time-groups.js";

// Late enough in the month that "Earlier this month" (>= the 1st) and
// "Last week" (>= 14 days back) don't collapse into each other.
const NOW = new Date("2026-06-25T12:00:00.000Z");

function thread(
  id: string,
  lastMessageAt: string | null,
  overrides: Partial<CachedThread> = {},
): CachedThread {
  return {
    id,
    mailAccountId: "acct-1",
    subject: `Subject ${id}`,
    participants: [],
    snippet: null,
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
    updatedAt: lastMessageAt ?? "2026-01-01T00:00:00.000Z",
    sortKey: `${lastMessageAt ?? "0000-01-01T00:00:00.000Z"}|${id}`,
    ...overrides,
  };
}

describe("timeGroupLabel", () => {
  it("buckets the common inbox ranges", () => {
    expect(timeGroupLabel("2026-06-25T09:00:00.000Z", NOW)).toBe("Today");
    expect(timeGroupLabel("2026-06-24T09:00:00.000Z", NOW)).toBe("Yesterday");
    expect(timeGroupLabel("2026-06-20T09:00:00.000Z", NOW)).toBe("This week");
    expect(timeGroupLabel("2026-06-12T09:00:00.000Z", NOW)).toBe("Last week");
    expect(timeGroupLabel("2026-06-03T09:00:00.000Z", NOW)).toBe("Earlier this month");
    expect(timeGroupLabel("2026-04-02T09:00:00.000Z", NOW)).toBe("April");
    expect(timeGroupLabel("2024-04-02T09:00:00.000Z", NOW)).toBe("April 2024");
  });

  it("falls back to Undated for a Thread whose dates haven't landed yet", () => {
    expect(timeGroupLabel(null, NOW)).toBe("Undated");
  });
});

describe("groupThreadsByTime", () => {
  it("buckets an already-ordered page into contiguous groups without re-sorting", () => {
    const threads = [
      thread("t1", "2026-06-25T09:00:00.000Z"), // Today
      thread("t2", "2026-06-25T08:00:00.000Z"), // Today
      thread("t3", "2026-06-24T09:00:00.000Z"), // Yesterday
      thread("t4", "2026-04-02T09:00:00.000Z"), // April
    ];

    const groups = groupThreadsByTime(threads, NOW);

    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "April"]);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["t3"]);
    expect(groups[2]?.threads.map((t) => t.id)).toEqual(["t4"]);
  });

  it("keeps two separate groups of the same label from re-merging out of order", () => {
    // "Today" -> "Yesterday" -> "Today" should never happen given
    // newest-first input, but the grouping pass must not silently merge
    // non-contiguous runs even if it did.
    const threads = [
      thread("t1", "2026-06-25T09:00:00.000Z"),
      thread("t2", "2026-06-24T09:00:00.000Z"),
      thread("t3", "2026-06-25T08:00:00.000Z"),
    ];
    const groups = groupThreadsByTime(threads, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Today"]);
  });

  it("groups Pinned Threads (#43) under one Pinned header regardless of their own date", () => {
    const threads = [
      thread("t1", "2026-04-02T09:00:00.000Z", { pinned: true }), // April, but Pinned
      thread("t2", "2026-06-25T09:00:00.000Z", { pinned: true }), // Today, but Pinned
      thread("t3", "2026-06-25T08:00:00.000Z"), // Today, not pinned
    ];

    const groups = groupThreadsByTime(threads, NOW);

    expect(groups.map((g) => g.label)).toEqual([PINNED_GROUP_LABEL, "Today"]);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["t3"]);
  });
});

describe("formatRowTime", () => {
  it("formats recent times compactly", () => {
    expect(formatRowTime("2026-06-25T11:45:00.000Z", NOW)).toBe("15m");
    expect(formatRowTime("2026-06-25T09:00:00.000Z", NOW)).toBe("3h");
    expect(formatRowTime("2026-06-24T09:00:00.000Z", NOW)).toBe("Yest.");
    expect(formatRowTime("2026-06-01T09:00:00.000Z", NOW)).toBe("1 Jun");
  });
});
