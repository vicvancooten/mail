import { SWIPE_COMMIT_THRESHOLD_PX, useHorizontalSwipe } from "./useHorizontalSwipe.js";
import type { HorizontalSwipe } from "./useHorizontalSwipe.js";

/**
 * Swipe-to-Done/-Trash on touch (#149, #133's own "Swipe to Triage" decision:
 * "One gesture module serves list rows and Stream cards: right = Done, left
 * = Trash"). One `ThreadRow` or Stream card calls this once and spreads
 * `handlers` onto its swipeable surface; `offsetX`/`revealing` drive the drag
 * transform and the background reveal purely from render, no imperative DOM
 * writes. Snooze is not a swipe outcome any more (#149 removes it from here
 * — it stays a visible row action on phone instead, `ThreadRow.tsx`'s own
 * hover-cluster wiring for that).
 *
 * The pointer-gesture mechanics themselves (touch-only capture, dead zone,
 * clamp, threshold-commit-or-snap-back) live in `useHorizontalSwipe.ts`,
 * shared with #150's Reader swipe-to-navigate — this is just that hook with
 * archive/trash named as its two outcomes.
 */

/** Re-exported for existing callers/tests that import the threshold from here. */
export { SWIPE_COMMIT_THRESHOLD_PX };

export type SwipeAction = "archive" | "trash";

export type SwipeToTriage = HorizontalSwipe<SwipeAction>;

export function useSwipeToTriage({
  onArchive,
  onTrash,
}: {
  /** Swipe right, past the threshold: Done. */
  onArchive: () => void;
  /** Swipe left, past the threshold: Trash (#149 — was Snooze, which is no longer a swipe outcome). */
  onTrash: () => void;
}): SwipeToTriage {
  return useHorizontalSwipe<SwipeAction>({
    right: "archive",
    left: "trash",
    onCommitRight: onArchive,
    onCommitLeft: onTrash,
  });
}
