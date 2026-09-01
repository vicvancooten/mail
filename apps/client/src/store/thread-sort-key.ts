import type { Thread } from "@mail/shared";

/**
 * Every PoC view is date-ordered (ADR-0009), so the Local Cache stores one
 * derived `sortKey` per Thread and indexes on it. Keeping it a single
 * lexicographically-ordered string is what lets a list window be expressed
 * as an IndexedDB range — "everything at or above this key" — rather than a
 * materialized array of ids that every delta would have to rewrite.
 */

/** Sorts below every real timestamp, for a Thread whose dates the backend hasn't filled in yet. */
const UNDATED = "0000-01-01T00:00:00.000Z";

/**
 * `z.iso.datetime()` accepts both `…:00Z` and `…:00.000Z`, and those two sort
 * the wrong way round as raw strings (`.` < `Z`), so the timestamp half is
 * always re-serialized to the fixed-width millisecond form before it becomes
 * part of a key.
 */
function normalizeTimestamp(value: string | null): string {
  if (value === null) return UNDATED;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return UNDATED;
  return parsed.toISOString();
}

/**
 * Newest-last ordering key for a Thread: its date, then its id as a
 * tiebreak so two Threads sharing a timestamp still have a stable total
 * order (an unstable one would make "the 500th newest" — the eviction
 * cutoff — ambiguous, and would let a list flicker between renders).
 */
export function threadSortKey(
  thread: Pick<Thread, "id" | "lastMessageAt" | "firstMessageAt">,
): string {
  return `${normalizeTimestamp(thread.lastMessageAt ?? thread.firstMessageAt)}|${thread.id}`;
}
