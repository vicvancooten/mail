import { useCallback, useRef, useState } from "react";

/**
 * Swipe-to-archive/-trash on touch (#44, `poc-scope.md` §Clients &
 * notifications: "swipe gestures on touch"). One `ThreadRow` calls this once
 * and spreads `handlers` onto its swipeable surface; `offsetX`/`revealing`
 * drive the drag transform and the background reveal purely from render, no
 * imperative DOM writes.
 *
 * Deliberately Pointer Events, gated to `pointerType === "touch"`: a mouse
 * drag on desktop must not trigger this (there's no equivalent affordance to
 * reveal, and it would fight text selection), and Pointer Events (over
 * `touchstart`/`touchmove`) are what let `setPointerCapture` keep delivering
 * moves once the finger leaves the row's bounds mid-swipe.
 *
 * `touch-action: pan-y` on the row (`mail.css`) is what makes this safe
 * inside a vertically-scrolling list without any manual axis-lock logic
 * here: the browser recognizes a vertical gesture as its own native scroll
 * and never delivers it to this hook as a sequence of pointermoves (a
 * `pointercancel` arrives instead, handled the same as an abandoned swipe),
 * so only genuinely horizontal drags ever move `offsetX`.
 */

/** Past this many px of horizontal drag, releasing commits the action instead of snapping back. */
export const SWIPE_COMMIT_THRESHOLD_PX = 88;
/** Below this, a jittery touch doesn't yet count as "a direction" — avoids a flickering reveal right at 0. */
const DIRECTION_DEAD_ZONE_PX = 8;
/** Drag is clamped here so the reveal never outruns what the row can visually show. */
const MAX_DRAG_PX = 160;

export type SwipeAction = "archive" | "trash";

export interface SwipeToTriage {
  /** Current horizontal drag offset, clamped to +/- `MAX_DRAG_PX`; 0 when idle. */
  offsetX: number;
  /** Which action `offsetX`'s current direction would commit, or `null` inside the dead zone. */
  revealing: SwipeAction | null;
  /** False while the finger is down (raw, un-transitioned drag); true for the snap-back/commit animation. */
  settling: boolean;
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  };
}

export function useSwipeToTriage({
  onArchive,
  onTrash,
}: {
  onArchive: () => void;
  onTrash: () => void;
}): SwipeToTriage {
  const [offsetX, setOffsetX] = useState(0);
  const [settling, setSettling] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);

  const reset = useCallback(() => {
    pointerIdRef.current = null;
    setSettling(true);
    setOffsetX(0);
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return;
    pointerIdRef.current = event.pointerId;
    startXRef.current = event.clientX;
    setSettling(false);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    const delta = event.clientX - startXRef.current;
    setOffsetX(Math.max(-MAX_DRAG_PX, Math.min(MAX_DRAG_PX, delta)));
  }, []);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      const delta = event.clientX - startXRef.current;
      if (delta >= SWIPE_COMMIT_THRESHOLD_PX) onArchive();
      else if (delta <= -SWIPE_COMMIT_THRESHOLD_PX) onTrash();
      reset();
    },
    [onArchive, onTrash, reset],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      reset();
    },
    [reset],
  );

  const revealing: SwipeAction | null =
    offsetX >= DIRECTION_DEAD_ZONE_PX
      ? "archive"
      : offsetX <= -DIRECTION_DEAD_ZONE_PX
        ? "trash"
        : null;

  return {
    offsetX,
    revealing,
    settling,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
