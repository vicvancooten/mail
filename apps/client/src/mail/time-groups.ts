import type { CachedThread } from "../store/index.js";

/**
 * Time-grouping headers for the thread list. The spec leaves the exact
 * buckets as fog ("pick something reasonable, expect iteration") — this
 * follows the common inbox convention (Today / Yesterday / This week / Last
 * week / by-month for the rest of the year / by-month-and-year before
 * that), the same shape the `prototype/triage-loop-ui` branch settled on.
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

/**
 * A Thread whose dates haven't landed yet (`lastMessageAt` and
 * `firstMessageAt` both null) groups under "Undated" rather than being
 * dropped or crashing the bucket math — `threadSortKey` already handles
 * this case the same way for ordering.
 */
export function timeGroupLabel(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "Undated";
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "Undated";

  const today = startOfDay(now);
  const yesterday = today - DAY_MS;
  const thisWeekStart = today - 7 * DAY_MS;
  const lastWeekStart = today - 14 * DAY_MS;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const thisYear = now.getFullYear();

  if (timestamp >= today) return "Today";
  if (timestamp >= yesterday) return "Yesterday";
  if (timestamp >= thisWeekStart) return "This week";
  if (timestamp >= lastWeekStart) return "Last week";
  if (timestamp >= monthStart) return "Earlier this month";

  const d = new Date(timestamp);
  if (d.getFullYear() === thisYear) return MONTH_NAMES[d.getMonth()] as string;
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
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
  threads: CachedThread[];
}

/** The synthetic group label a Pinned Thread (#43) surfaces under, ahead of every date-based group. */
export const PINNED_GROUP_LABEL = "Pinned";

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
    else groups.push({ label, threads: [thread] });
  }
  return groups;
}
