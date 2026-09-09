import { useCallback, useRef, useState } from "react";

/**
 * Shared pointer-gesture mechanics behind every horizontal swipe in Mail:
 * #149's swipe-to-triage on list rows and Stream cards, and #150's Reader
 * swipe-to-navigate. Both are "touch-only pointer capture, a dead zone
 * before a direction reveals, a clamped drag distance, and threshold-commit-
 * or-snap-back on release" — the same mechanics, applied to a different
 * pair of outcomes and a different DOM surface. This hook knows only the
 * mechanics; `useSwipeToTriage.ts` and `useSwipeToNavigate.ts` are both thin
 * wrappers naming what a rightward vs. leftward commit *means*, so the two
 * gestures can never drift apart in feel while still never firing the same
 * outcome as one another (they're two separate hook instances on two
 * separate surfaces — a row/card underneath a Reader is never touchable at
 * the same time the Reader's own pane is).
 *
 * Deliberately Pointer Events, gated to `pointerType === "touch"`: a mouse
 * drag on desktop must not trigger this, and Pointer Events (over
 * `touchstart`/`touchmove`) are what let `setPointerCapture` keep delivering
 * moves once the finger leaves the surface's bounds mid-swipe.
 *
 * `touch-action: pan-y` on the swipeable surface (mail.css/stream.css) is
 * what makes this safe inside a vertically-scrolling pane without any
 * manual axis-lock logic here: the browser recognizes a vertical gesture as
 * its own native scroll and never delivers it to this hook as a sequence of
 * pointermoves (a `pointercancel` arrives instead, handled the same as an
 * abandoned swipe), so only genuinely horizontal drags ever move `offsetX`.
 */

/** Past this many px of horizontal drag, releasing commits the outcome instead of snapping back. */
export const SWIPE_COMMIT_THRESHOLD_PX = 88;
/** Below this, a jittery touch doesn't yet count as "a direction" — avoids a flickering reveal right at 0. */
const DIRECTION_DEAD_ZONE_PX = 8;
/** Drag is clamped here so the reveal never outruns what the surface can visually show. */
const MAX_DRAG_PX = 160;

export interface HorizontalSwipe<TOutcome extends string> {
  /** Current horizontal drag offset, clamped to +/- `MAX_DRAG_PX`; 0 when idle. */
  offsetX: number;
  /** Which outcome `offsetX`'s current direction would commit, or `null` inside the dead zone. */
  revealing: TOutcome | null;
  /** False while the finger is down (raw, un-transitioned drag); true for the snap-back/commit animation. */
  settling: boolean;
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  };
}

export function useHorizontalSwipe<TOutcome extends string>({
  right,
  left,
  onCommitRight,
  onCommitLeft,
}: {
  /** Name for a rightward, past-threshold commit — drives `revealing` only. */
  right: TOutcome;
  /** Name for a leftward, past-threshold commit — drives `revealing` only. */
  left: TOutcome;
  onCommitRight: () => void;
  onCommitLeft: () => void;
}): HorizontalSwipe<TOutcome> {
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
      if (delta >= SWIPE_COMMIT_THRESHOLD_PX) onCommitRight();
      else if (delta <= -SWIPE_COMMIT_THRESHOLD_PX) onCommitLeft();
      reset();
    },
    [onCommitRight, onCommitLeft, reset],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      reset();
    },
    [reset],
  );

  const revealing: TOutcome | null =
    offsetX >= DIRECTION_DEAD_ZONE_PX ? right : offsetX <= -DIRECTION_DEAD_ZONE_PX ? left : null;

  return {
    offsetX,
    revealing,
    settling,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
