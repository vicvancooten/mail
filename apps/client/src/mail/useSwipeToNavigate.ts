import type { HorizontalSwipe } from "./useHorizontalSwipe.js";
import { useHorizontalSwipe } from "./useHorizontalSwipe.js";

/**
 * Swipe between Threads inside the Reader (#150, #133's Navigation decision:
 * "Reader swipe (phone): horizontal swipe navigates to the adjacent Thread
 * using the same neighbour logic as prev/next; fixed direction, independent
 * of Auto-advance"). `ThreadDetailPane` calls this once and spreads
 * `handlers` onto the pane itself; `onPrev`/`onNext` are exactly the same
 * callbacks its own (desktop-only) chevron buttons already call — a User
 * story #12 swipe right therefore reaches the previous (newer) Thread and
 * swipe left the next (older) one for the same reason the buttons do:
 * `SplitView`/`ListView` compute both from `neighborId`, and at either end
 * of the list the missing callback makes the corresponding swipe direction
 * silently do nothing (SplitView.tsx/ListView.tsx's own `prevId ? ... :
 * undefined` — this hook has no separate "at the ends" case to get wrong).
 *
 * Reusing the same `onSelect` callback the buttons use is also what keeps
 * this a history *replace*, never a push, with no special-casing here:
 * `MailRoute.tsx` already replaces for any `"select"` while a Thread is
 * already open, buttons or swipe alike.
 *
 * A separate hook from `useSwipeToTriage`, not a parameterization of it,
 * because the two are never the same call site: the Reader pane a User
 * swipes across here is never the same touch surface as a list row or a
 * Stream card (Stream doesn't pass `onPrev`/`onNext` at all — "Stream is a
 * one-way stack to drain, not a list to browse" — so its own card-swipe for
 * Done/Trash is the only gesture live on that surface, unconflicted). Both
 * hooks share their pointer mechanics via `useHorizontalSwipe.ts` so the two
 * gestures can never feel different from one another despite meaning
 * different things.
 */

export type SwipeDirection = "prev" | "next";

export type SwipeToNavigate = HorizontalSwipe<SwipeDirection>;

export function useSwipeToNavigate({
  onPrev,
  onNext,
}: {
  /** Swipe right, past the threshold: the previous (newer) Thread. */
  onPrev?: () => void;
  /** Swipe left, past the threshold: the next (older) Thread. */
  onNext?: () => void;
}): SwipeToNavigate {
  return useHorizontalSwipe<SwipeDirection>({
    right: "prev",
    left: "next",
    onCommitRight: () => onPrev?.(),
    onCommitLeft: () => onNext?.(),
  });
}
