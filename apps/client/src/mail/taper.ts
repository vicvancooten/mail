import type { ListDensity } from "./device-preferences.js";
import type { TimeGroupTier } from "./time-groups.js";

/**
 * The taper (#66, #75): reverse-chronological rank expressed as scale. Each
 * tier's row and header height is declared exactly once, here, and consumed
 * both by `VirtualizedThreadList`'s `estimateSize` *and* as the row/header's
 * own rendered height (an inline style, not a `mail.css` class) — the
 * ticket's "per-tier row heights are known to the virtualizer, not
 * duplicated between code and CSS". `mail.css` only styles *within* whatever
 * height these functions hand it: avatar size, weight, ink.
 *
 * Comfortable values taper from T1 (loudest — Pinned/Today) down to T4
 * (quietest — the two named months, Older, Undated); `compact` shifts every
 * tier by the same fixed delta rather than flattening the taper to one size
 * (#54's Device Preference, CONTEXT.md: "means something different on each
 * device", not "means the taper stops mattering").
 */

const COMFORTABLE_ROW_HEIGHT: Readonly<Record<TimeGroupTier, number>> = {
  1: 72,
  2: 60,
  3: 52,
  4: 44,
};

const COMFORTABLE_HEADER_HEIGHT: Readonly<Record<TimeGroupTier, number>> = {
  1: 40,
  2: 34,
  3: 30,
  4: 26,
};

/** Compact shifts every tier's row by this many px — never re-derives a flat height. */
const COMPACT_ROW_DELTA = 16;
/** Compact shifts every tier's header by this many px. */
const COMPACT_HEADER_DELTA = 8;

export function taperRowHeight(tier: TimeGroupTier, density: ListDensity): number {
  const height = COMFORTABLE_ROW_HEIGHT[tier];
  return density === "compact" ? height - COMPACT_ROW_DELTA : height;
}

export function taperHeaderHeight(tier: TimeGroupTier, density: ListDensity): number {
  const height = COMFORTABLE_HEADER_HEIGHT[tier];
  return density === "compact" ? height - COMPACT_HEADER_DELTA : height;
}

/**
 * The flat row height an *ungrouped* list uses — search's "ranked, no
 * time-grouping headers, no taper" result list (search-ux-spec.md §The
 * result list, and #66's "Stream mode suppresses the taper entirely... the
 * same way search already suppresses Stream"). Kept at the same size the
 * loudest comfortable tier used before the taper existed, so search's rows
 * don't visibly jump in size the day this ships.
 */
export function ungroupedRowHeight(density: ListDensity): number {
  return density === "compact"
    ? COMFORTABLE_ROW_HEIGHT[2] - COMPACT_ROW_DELTA
    : COMFORTABLE_ROW_HEIGHT[2];
}
