import { describe, expect, it } from "vitest";
import type { CachedThread } from "../store/index.js";
import {
  formatRowTime,
  groupThreadsByTime,
  PINNED_GROUP_LABEL,
  timeGroupLabel,
  timeGroupTier,
} from "./time-groups.js";

// Late enough in the month that "This month" (>= the 1st) and "Last week"
// (>= 14 days back) don't collapse into each other.
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
    folderRole: "inbox",
    hasSentMessage: false,
    pinned: false,
    labelIds: [],
    gmailLabelIds: [],
    heldSender: null,
    heldRecipientAlias: null,
    snoozeUntil: null,
    updatedAt: lastMessageAt ?? "2026-01-01T00:00:00.000Z",
    sortKey: `${lastMessageAt ?? "0000-01-01T00:00:00.000Z"}|${id}`,
    ...overrides,
  };
}

describe("timeGroupLabel", () => {
  it("buckets the common inbox ranges, including the two named months", () => {
    expect(timeGroupLabel("2026-06-25T09:00:00.000Z", NOW)).toBe("Today");
    expect(timeGroupLabel("2026-06-24T09:00:00.000Z", NOW)).toBe("Yesterday");
    expect(timeGroupLabel("2026-06-20T09:00:00.000Z", NOW)).toBe("This week");
    expect(timeGroupLabel("2026-06-12T09:00:00.000Z", NOW)).toBe("Last week");
    expect(timeGroupLabel("2026-06-03T09:00:00.000Z", NOW)).toBe("This month");
    expect(timeGroupLabel("2026-05-10T09:00:00.000Z", NOW)).toBe("May"); // previous month
    expect(timeGroupLabel("2026-04-10T09:00:00.000Z", NOW)).toBe("April"); // month before that
  });

  it("collapses everything before the two named months into one Older group", () => {
    expect(timeGroupLabel("2026-03-31T09:00:00.000Z", NOW)).toBe("Older");
    expect(timeGroupLabel("2024-04-02T09:00:00.000Z", NOW)).toBe("Older");
    expect(timeGroupLabel("2010-01-01T09:00:00.000Z", NOW)).toBe("Older");
  });

  it("qualifies a named month with its year once it's not the current year", () => {
    const januaryNow = new Date("2026-01-15T12:00:00.000Z");
    expect(timeGroupLabel("2025-12-20T09:00:00.000Z", januaryNow)).toBe("December 2025");
    expect(timeGroupLabel("2025-11-20T09:00:00.000Z", januaryNow)).toBe("November 2025");
    expect(timeGroupLabel("2025-10-20T09:00:00.000Z", januaryNow)).toBe("Older");
  });

  it("falls back to Undated for a Thread whose dates haven't landed yet, or don't parse", () => {
    expect(timeGroupLabel(null, NOW)).toBe("Undated");
    expect(timeGroupLabel("not-a-date", NOW)).toBe("Undated");
  });
});

describe("timeGroupTier", () => {
  it("maps the ladder onto the four taper tiers, keyed to semantic recency", () => {
    expect(timeGroupTier(PINNED_GROUP_LABEL)).toBe(1);
    expect(timeGroupTier("Today")).toBe(1);
    expect(timeGroupTier("Yesterday")).toBe(2);
    expect(timeGroupTier("This week")).toBe(2);
    expect(timeGroupTier("Last week")).toBe(3);
    expect(timeGroupTier("This month")).toBe(3);
    // The two named months, Older and Undated all land on T4 regardless of
    // which months they happen to be — tier is keyed to the label's meaning
    // (T4: distant/unknown), never to the month's ordinal position.
    expect(timeGroupTier("May")).toBe(4);
    expect(timeGroupTier("April 2024")).toBe(4);
    expect(timeGroupTier("Older")).toBe(4);
    expect(timeGroupTier("Undated")).toBe(4);
  });

  it("never promotes an older group to a louder tier just because a louder one is empty", () => {
    // A quiet morning with nothing from Today: Yesterday still reads as T2,
    // not promoted to T1 because it happens to lead the list.
    expect(timeGroupTier("Yesterday")).toBe(2);
    expect(timeGroupTier("Last week")).toBe(3);
  });
});

describe("groupThreadsByTime", () => {
  it("buckets an already-ordered page into contiguous groups without re-sorting", () => {
    const threads = [
      thread("t1", "2026-06-25T09:00:00.000Z"), // Today
      thread("t2", "2026-06-25T08:00:00.000Z"), // Today
      thread("t3", "2026-06-24T09:00:00.000Z"), // Yesterday
      thread("t4", "2026-05-10T09:00:00.000Z"), // May
      thread("t5", "2010-01-01T09:00:00.000Z"), // Older
      thread("t6", null), // Undated
    ];

    const groups = groupThreadsByTime(threads, NOW);

    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "May", "Older", "Undated"]);
    expect(groups.map((g) => g.tier)).toEqual([1, 2, 4, 4, 4]);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["t3"]);
    expect(groups[2]?.threads.map((t) => t.id)).toEqual(["t4"]);
    expect(groups[3]?.threads.map((t) => t.id)).toEqual(["t5"]);
    expect(groups[4]?.threads.map((t) => t.id)).toEqual(["t6"]);
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

  it("groups Pinned Threads (#43) under one Pinned header, leading, at tier 1, regardless of their own date", () => {
    const threads = [
      thread("t1", "2010-01-01T09:00:00.000Z", { pinned: true }), // ancient, but Pinned
      thread("t2", "2026-06-25T09:00:00.000Z", { pinned: true }), // Today, but Pinned
      thread("t3", "2026-06-25T08:00:00.000Z"), // Today, not pinned
    ];

    const groups = groupThreadsByTime(threads, NOW);

    expect(groups.map((g) => g.label)).toEqual([PINNED_GROUP_LABEL, "Today"]);
    expect(groups[0]?.tier).toBe(1);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(groups[1]?.threads.map((t) => t.id)).toEqual(["t3"]);
  });

  it("produces no groups, and no error, for an empty page", () => {
    expect(groupThreadsByTime([], NOW)).toEqual([]);
  });

  it("keeps tier mapping stable when the loudest tiers are empty (quiet-morning case)", () => {
    // Nothing from Today or Yesterday: the leading group is "This week",
    // which must still read as T2 — not promoted to T1 just because it's
    // first on screen.
    const threads = [
      thread("t1", "2026-06-20T09:00:00.000Z"), // This week
      thread("t2", "2026-06-12T09:00:00.000Z"), // Last week
    ];
    const groups = groupThreadsByTime(threads, NOW);
    expect(groups.map((g) => g.label)).toEqual(["This week", "Last week"]);
    expect(groups.map((g) => g.tier)).toEqual([2, 3]);
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
