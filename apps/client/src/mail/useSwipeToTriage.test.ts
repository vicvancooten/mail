import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SWIPE_COMMIT_THRESHOLD_PX, useSwipeToTriage } from "./useSwipeToTriage.js";

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

describe("useSwipeToTriage", () => {
  it("ignores non-touch pointers (a mouse drag must not trigger anything)", () => {
    const onArchive = vi.fn();
    const onSnooze = vi.fn();
    const { result } = renderHook(() => useSwipeToTriage({ onArchive, onSnooze }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ pointerType: "mouse", clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ pointerType: "mouse", clientX: 200 }));
    });

    expect(result.current.offsetX).toBe(0);
  });

  it("tracks offsetX and reveals archive while dragging right of the dead zone", () => {
    const { result } = renderHook(() =>
      useSwipeToTriage({ onArchive: vi.fn(), onSnooze: vi.fn() }),
    );

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ clientX: 40 }));
    });

    expect(result.current.offsetX).toBe(40);
    expect(result.current.revealing).toBe("archive");
  });

  it("reveals snooze while dragging left", () => {
    const { result } = renderHook(() =>
      useSwipeToTriage({ onArchive: vi.fn(), onSnooze: vi.fn() }),
    );

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ clientX: -40 }));
    });

    expect(result.current.revealing).toBe("snooze");
  });

  it("commits archive on release past the threshold to the right", () => {
    const onArchive = vi.fn();
    const onSnooze = vi.fn();
    const { result } = renderHook(() => useSwipeToTriage({ onArchive, onSnooze }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(
        pointerEvent({ clientX: SWIPE_COMMIT_THRESHOLD_PX + 5 }),
      );
      result.current.handlers.onPointerUp(pointerEvent({ clientX: SWIPE_COMMIT_THRESHOLD_PX + 5 }));
    });

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onSnooze).not.toHaveBeenCalled();
    expect(result.current.offsetX).toBe(0); // snaps back to idle once the action is queued
  });

  it("commits snooze on release past the threshold to the left", () => {
    const onArchive = vi.fn();
    const onSnooze = vi.fn();
    const { result } = renderHook(() => useSwipeToTriage({ onArchive, onSnooze }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerUp(
        pointerEvent({ clientX: -(SWIPE_COMMIT_THRESHOLD_PX + 5) }),
      );
    });

    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("snaps back without committing when released short of the threshold", () => {
    const onArchive = vi.fn();
    const onSnooze = vi.fn();
    const { result } = renderHook(() => useSwipeToTriage({ onArchive, onSnooze }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ clientX: 30 }));
      result.current.handlers.onPointerUp(pointerEvent({ clientX: 30 }));
    });

    expect(onArchive).not.toHaveBeenCalled();
    expect(onSnooze).not.toHaveBeenCalled();
    expect(result.current.offsetX).toBe(0);
  });

  it("resets to idle on pointercancel (e.g. the browser claiming the gesture as a vertical scroll)", () => {
    const onArchive = vi.fn();
    const { result } = renderHook(() => useSwipeToTriage({ onArchive, onSnooze: vi.fn() }));

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ clientX: 120 }));
      result.current.handlers.onPointerCancel(pointerEvent({ clientX: 120 }));
    });

    expect(result.current.offsetX).toBe(0);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("clamps offsetX so the reveal never outruns the row", () => {
    const { result } = renderHook(() =>
      useSwipeToTriage({ onArchive: vi.fn(), onSnooze: vi.fn() }),
    );

    act(() => {
      result.current.handlers.onPointerDown(pointerEvent({ clientX: 0 }));
      result.current.handlers.onPointerMove(pointerEvent({ clientX: 10_000 }));
    });

    expect(result.current.offsetX).toBeLessThanOrEqual(160);
  });
});
