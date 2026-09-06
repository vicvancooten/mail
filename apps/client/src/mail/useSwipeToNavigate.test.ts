import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SWIPE_COMMIT_THRESHOLD_PX } from "./useHorizontalSwipe.js";
import { useSwipeToNavigate } from "./useSwipeToNavigate.js";

/** A fake `React.PointerEvent` with only what the hook reads. */
function pointerEvent(overrides: {
  pointerId?: number;
  pointerType?: string;
  clientX?: number;
}): React.PointerEvent<HTMLElement> {
  return {
    pointerId: overrides.pointerId ?? 1,
    pointerType: overrides.pointerType ?? "touch",
    clientX: overrides.clientX ?? 0,
    currentTarget: { setPointerCapture: vi.fn() },
  } as unknown as React.PointerEvent<HTMLElement>;
}

describe("useSwipeToNavigate", () => {
  it("ignores non-touch pointers (a mouse drag must not navigate)", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { result } = renderHook(() => useSwipeToNavigate({ onPrev, onNext }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ pointerType: "mouse", clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ pointerType: "mouse", clientX: 200 }));
      result.current.handlers.onPointerUp(pointerEvent({ pointerType: "mouse", clientX: 200 }));
    });

    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("commits onPrev (the previous/newer Thread) on release past the threshold to the right", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { result } = renderHook(() => useSwipeToNavigate({ onPrev, onNext }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(
        pointerEvent({ clientX: SWIPE_COMMIT_THRESHOLD_PX + 5 }),
      );
      result.current.handlers.onPointerUp(pointerEvent({ clientX: SWIPE_COMMIT_THRESHOLD_PX + 5 }));
    });

    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    expect(result.current.offsetX).toBe(0);
  });

  it("commits onNext (the next/older Thread) on release past the threshold to the left", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { result } = renderHook(() => useSwipeToNavigate({ onPrev, onNext }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerUp(
        pointerEvent({ clientX: -(SWIPE_COMMIT_THRESHOLD_PX + 5) }),
      );
    });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it("snaps back without committing when released short of the threshold", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { result } = renderHook(() => useSwipeToNavigate({ onPrev, onNext }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ clientX: 30 }));
      result.current.handlers.onPointerUp(pointerEvent({ clientX: 30 }));
    });

    expect(onPrev).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    expect(result.current.offsetX).toBe(0);
  });

  it("does nothing at the ends of the list, where the missing neighbour callback is simply absent", () => {
    // SplitView/ListView pass `undefined` for a neighbour that doesn't
    // exist (`prevId ? ... : undefined`) — this hook must not throw or
    // otherwise misbehave when swiped toward that missing side.
    const onNext = vi.fn();
    const { result } = renderHook(() => useSwipeToNavigate({ onPrev: undefined, onNext }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerUp(pointerEvent({ clientX: SWIPE_COMMIT_THRESHOLD_PX + 5 }));
    });

    expect(onNext).not.toHaveBeenCalled();
  });
});
