import type { BulkTriageFolderRole, BulkTriageTarget } from "@mail/shared";
import type { FolderKey } from "./folders.js";
import { monthLabel, monthStartBefore, PINNED_GROUP_LABEL, startOfDay } from "./time-groups.js";

/**
 * The group header cluster's target-set math (#66, #67, #77): turning a
 * rendered date-group header — "Today", "Last week", a named month — back
 * into the **date range + folder + Account Scope** shape
 * `@mail/shared#bulkTriageTargetSchema` wants, and the current `FolderKey`
 * into the wire's `BulkTriageFolderRole`. The Client never sends a
 * thread-id list (#67's whole point): a group's own header is the only
 * thing "Done all"/"Mark all read" ever names.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GroupDateRange {
  /** Inclusive lower bound on `Thread.lastMessageAt`, `null` for "everything older". */
  since: string | null;
  /** Exclusive upper bound, `null` for "up to now" (the server clamps this, never the Client — `bulk-triage.ts` (sync-backend) doc comment). */
  until: string | null;
}

/**
 * Inverts `time-groups.ts#timeGroupLabel`'s bucket boundaries: given a
 * rendered header label, the `since`/`until` bounds that label's Threads
 * fall inside. `null` for the Pinned pseudo-group (its label doesn't
 * reflect its own Threads' dates at all) and "Undated" (nothing to bound a
 * `null` `lastMessageAt` by) — neither is a valid bulk-Triage target, so the
 * group header cluster never arms for them (`VirtualizedThreadList`).
 */
export function groupDateRange(label: string, now: Date = new Date()): GroupDateRange | null {
  if (label === PINNED_GROUP_LABEL || label === "Undated") return null;

  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const thisWeekStart = today - 7 * DAY_MS;
  const lastWeekStart = today - 14 * DAY_MS;
  const monthStart = monthStartBefore(now, 0);
  const prevMonthStart = monthStartBefore(now, 1);
  const twoMonthsAgoStart = monthStartBefore(now, 2);
  const thisYear = now.getFullYear();
  const iso = (ms: number) => new Date(ms).toISOString();

  switch (label) {
    case "Today":
      return { since: iso(today), until: null };
    case "Yesterday":
      return { since: iso(yesterday), until: iso(today) };
    case "This week":
      return { since: iso(thisWeekStart), until: iso(yesterday) };
    case "Last week":
      return { since: iso(lastWeekStart), until: iso(thisWeekStart) };
    case "This month":
      return { since: iso(monthStart), until: iso(lastWeekStart) };
    case "Older":
      return { since: null, until: iso(twoMonthsAgoStart) };
    default:
      if (label === monthLabel(prevMonthStart, thisYear)) {
        return { since: iso(prevMonthStart), until: iso(monthStart) };
      }
      if (label === monthLabel(twoMonthsAgoStart, thisYear)) {
        return { since: iso(twoMonthsAgoStart), until: iso(prevMonthStart) };
      }
      return null;
  }
}

/**
 * `FolderKey` → `BulkTriageFolderRole`: the four sidebar destinations a bulk
 * target can actually name — Screener, Snoozed, Pinned and Drafts aren't
 * `Thread.lastMessageAt`-ordered mailbox folders the batch endpoint knows
 * how to bound, so `MailSection` never hands `VirtualizedThreadList` a
 * `groupBulk` controller while one of those is showing.
 */
export function bulkTriageFolderRoleForFolder(folder: FolderKey): BulkTriageFolderRole | null {
  switch (folder) {
    case "inbox":
      return "inbox";
    case "archive":
      return "archive";
    case "trash":
      return "trash";
    case "sent":
      return "sent";
    default:
      return null;
  }
}

export function bulkTriageTarget(
  accountScope: readonly string[],
  folderRole: BulkTriageFolderRole,
  range: GroupDateRange,
): BulkTriageTarget {
  return { accountScope: [...accountScope], folderRole, since: range.since, until: range.until };
}
