import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useChromeRetract } from "./useChromeRetract.js";

/**
 * A scrollable target `useChromeRetract`'s capture-phase `window` listener
 * can observe — jsdom's own `scrollTop` is a plain settable property (no
 * real layout backs it), so this stands in for whichever of Mail's several
 * scroll containers is live, the same way the hook itself doesn't care
 * which one it is.
 */
function scrollTarget(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  Object.defineProperty(el, "scrollTop", { value: 0, configurable: true, writable: true });
  return el;
}

/** Lets the hook's `requestAnimationFrame`-batched decision run and settle. */
async function nextFrame() {
  await act(async () => {
    await new Promise<number>((resolve) => requestAnimationFrame(resolve));
  });
}

/**
 * Walks a target to `top` in small steps, awaiting a frame between each —
 * a real scroll gesture fires many events with small deltas, never one
 * teleport, which is what lets `useChromeRetract`'s per-event decision run
 * for every step rather than only the first (the hook rAF-batches *within*
 * one tick, so steps fired without a frame between them would collapse to
 * just the first one's delta). A target's very first-ever reading has no
 * prior position to compare against and commits no decision by design (no
 * false retract the instant a fresh scroll container mounts already
 * scrolled) — the small first step here is that priming read.
 */
async function scrollTo(el: HTMLElement, top: number, steps = 4) {
  const start = (el as unknown as { scrollTop: number }).scrollTop;
  for (let i = 1; i <= steps; i++) {
    const next = Math.round(start + ((top - start) * i) / steps);
    Object.defineProperty(el, "scrollTop", { value: next, configurable: true, writable: true });
    el.dispatchEvent(new Event("scroll"));
    await nextFrame();
  }
}

describe("useChromeRetract", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays shown until scrolled down past the threshold", async () => {
    const el = scrollTarget();
    const { result } = renderHook(() => useChromeRetract("/mail"));
    expect(result.current).toBe(false);

    await scrollTo(el, 120);

    expect(result.current).toBe(true);
  });

  it("never hides this close to the top of the container", async () => {
    const el = scrollTarget();
    const { result } = renderHook(() => useChromeRetract("/mail"));

    await scrollTo(el, 18);

    expect(result.current).toBe(false);
  });

  it("returns on any scroll-up, not just back near the top", async () => {
    const el = scrollTarget();
    const { result } = renderHook(() => useChromeRetract("/mail"));

    await scrollTo(el, 200);
    expect(result.current).toBe(true);

    await scrollTo(el, 190); // 10px up — well short of the top
    expect(result.current).toBe(false);
  });

  it("tracks each scroll target's own last position independently", async () => {
    const listEl = scrollTarget();
    const readerEl = scrollTarget();
    const { result } = renderHook(() => useChromeRetract("/mail"));

    await scrollTo(listEl, 300);
    expect(result.current).toBe(true);

    // A fresh target's first-ever reading primes its own baseline and
    // commits no decision — the chrome stays exactly as the list left it,
    // rather than being compared against the list's unrelated 300px and
    // read as a huge, spurious scroll-up.
    await scrollTo(readerEl, 50);
    expect(result.current).toBe(true);

    // From that new baseline, an ordinary scroll-up on readerEl still
    // reveals, same as any other target.
    await scrollTo(readerEl, 5);
    expect(result.current).toBe(false);
  });

  it("resets to shown, forgetting every scroll position, when resetKey changes", async () => {
    const el = scrollTarget();
    const { result, rerender } = renderHook(({ key }) => useChromeRetract(key), {
      initialProps: { key: "/mail" },
    });

    await scrollTo(el, 200);
    expect(result.current).toBe(true);

    rerender({ key: "/settings" });
    expect(result.current).toBe(false);
  });
});
