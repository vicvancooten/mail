import type { CachedThread } from "../store/index.js";

/**
 * Time-grouping headers for the thread list (#69, #66 "Group ladder and
 * taper"). The ladder: Pinned · Today · Yesterday · This week · Last week ·
 * This month · the previous month by name · the month before that by name ·
 * Older · Undated. Month-by-month and month-with-year buckets for anything
 * further back collapse into one Older group, so "clear everything old" has
 * an honest target — this replaced the old per-month/per-year ladder
 * (`prototype/triage-loop-ui`'s shape).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function startOfDay(date: Date): number {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/** A month, named — qualified with its year once that year isn't `now`'s. */
function monthLabel(monthStartMs: number, thisYear: number): string {
  const d = new Date(monthStartMs);
  const name = MONTH_NAMES[d.getMonth()] as string;
  return d.getFullYear() === thisYear ? name : `${name} ${d.getFullYear()}`;
}

/** The start-of-month timestamp `monthsAgo` months before `now`'s month. */
function monthStartBefore(now: Date, monthsAgo: number): number {
  return new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1).getTime();
}

/**
 * A Thread whose dates haven't landed yet (`lastMessageAt` and
 * `firstMessageAt` both null), or whose date doesn't parse, groups under
 * "Undated" rather than being dropped or crashing the bucket math —
 * `threadSortKey` already handles this case the same way for ordering.
 */
export function timeGroupLabel(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "Undated";
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "Undated";

  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const thisWeekStart = today - 7 * DAY_MS;
  const lastWeekStart = today - 14 * DAY_MS;
  const monthStart = monthStartBefore(now, 0);
  const prevMonthStart = monthStartBefore(now, 1);
  const twoMonthsAgoStart = monthStartBefore(now, 2);
  const thisYear = now.getFullYear();

  if (timestamp >= today) return "Today";
  if (timestamp >= yesterday) return "Yesterday";
  if (timestamp >= thisWeekStart) return "This week";
  if (timestamp >= lastWeekStart) return "Last week";
  if (timestamp >= monthStart) return "This month";
  if (timestamp >= prevMonthStart) return monthLabel(prevMonthStart, thisYear);
  if (timestamp >= twoMonthsAgoStart) return monthLabel(twoMonthsAgoStart, thisYear);
  return "Older";
}

/** The synthetic group label a Pinned Thread (#43) surfaces under, ahead of every date-based group. */
export const PINNED_GROUP_LABEL = "Pinned";

/**
 * The four taper tiers, keyed to a group's semantic recency rather than its
 * ordinal position in the ladder — so a quiet morning with nothing from
 * Today never promotes a two-week-old group to loudest (#66 user story 5).
 * Everything past the six fixed labels below — the two named months, Older,
 * and Undated — reads as T4 regardless of which months they happen to be.
 */
export type TimeGroupTier = 1 | 2 | 3 | 4;

const FIXED_TIER_BY_LABEL: Readonly<Record<string, TimeGroupTier>> = {
  [PINNED_GROUP_LABEL]: 1,
  Today: 1,
  Yesterday: 2,
  "This week": 2,
  "Last week": 3,
  "This month": 3,
};

export function timeGroupTier(label: string): TimeGroupTier {
  return FIXED_TIER_BY_LABEL[label] ?? 4;
}

/** Compact per-row time label: "2h", "Yest.", "3 Aug". */
export function formatRowTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "";
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "";

  const HOUR_MS = 60 * 60 * 1000;
  const diff = now.getTime() - timestamp;
  const today = startOfDay(now);
  if (diff < HOUR_MS) return `${Math.max(1, Math.round(diff / 60_000))}m`;
  if (timestamp >= today) return `${Math.round(diff / HOUR_MS)}h`;
  if (timestamp >= today - DAY_MS) return "Yest.";
  const d = new Date(timestamp);
  return `${d.getDate()} ${(MONTH_NAMES[d.getMonth()] as string).slice(0, 3)}`;
}

export interface ThreadGroup {
  label: string;
  /** This group's taper tier (`timeGroupTier(label)`) — carried alongside the label so a renderer never re-derives it. */
  tier: TimeGroupTier;
  threads: CachedThread[];
}

/**
 * Buckets an already newest-first, pinned-first ordered page
 * (`store/reads.ts#readThreadWindow`) into contiguous groups. Never
 * re-sorts — the order handed in is the order of record, and grouping is
 * purely a presentation pass over it. Pinned Threads (#43, CONTEXT.md:
 * "keep this in front of me") group under one `Pinned` header regardless of
 * their own date — `readThreadWindow` already put them first, this just
 * labels that leading run instead of scattering them across the ordinary
 * date buckets they'd otherwise fall into.
 */
export function groupThreadsByTime(
  threads: readonly CachedThread[],
  now: Date = new Date(),
): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (const thread of threads) {
    const label = thread.pinned
      ? PINNED_GROUP_LABEL
      : timeGroupLabel(thread.lastMessageAt ?? thread.firstMessageAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.threads.push(thread);
    else groups.push({ label, tier: timeGroupTier(label), threads: [thread] });
  }
  return groups;
}
