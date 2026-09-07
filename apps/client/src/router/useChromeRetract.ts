import { useEffect, useRef, useState } from "react";

/** Downward movement past this before the chrome hides — small enough to feel immediate, large enough that a single frame of scroll jitter never triggers it. */
const RETRACT_PX = 6;
/** Any upward movement past this brings the chrome straight back — returning should feel more eager than leaving. */
const REVEAL_PX = 4;
/** Never hides the chrome this close to the top of whatever's scrolling — the first screenful always keeps its chrome. */
const MIN_SCROLL_TOP = 24;

/**
 * The Hub header and phone bottom bar retract on scroll-down and return on
 * scroll-up (#155's own acceptance box), across whichever of Mail's several
 * independent scroll containers (the Thread list, the reading pane's body,
 * Settings' own page, Stream's card) happens to be live right now — rather
 * than wiring a `ref` into each of them one at a time, this attaches one
 * `scroll` listener to `window` in the *capture* phase. A `scroll` event
 * never bubbles, but capture-phase listeners still see it on the way down
 * to whatever descendant actually scrolled, which is what lets one listener
 * here stand in for however many bounded scroll panes the current route
 * happens to render.
 *
 * `resetKey` (the router's own pathname) clears the hidden state and the
 * per-target scroll memory on every route change — Settings ↔ Mail ↔ Stream
 * always starts with its chrome shown, rather than carrying over whatever a
 * previous screen's scroll position left behind. Within one route (opening
 * a Thread on the same `/mail` pathname, say) the chrome's state carries
 * over deliberately: a small scroll-up reveals it same as anywhere else.
 *
 * Runs regardless of viewport width — `shell.css`'s own `[data-chrome-
 * hidden="true"]` rule only exists inside the ≤700px phone query, so this
 * has no visible effect at all on desktop, the same "compute unconditionally,
 * let CSS decide" shape the rest of this shell already uses.
 */
export function useChromeRetract(resetKey: string): boolean {
  const [hidden, setHidden] = useState(false);
  // The scrollTop each target read *at the last point a decision actually
  // fired* — not the immediately preceding event. Anchoring to the last
  // event instead would let a slow drift (many small events, each short of
  // either threshold — exactly what momentum scrolling delivers) reset the
  // comparison every time and never accumulate into a real retract/reveal;
  // anchoring to the last decision lets those small deltas keep comparing
  // against one stable reference until they actually cross a threshold.
  const anchors = useRef(new WeakMap<EventTarget, number>());
  const pendingFrame = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` (the router's own pathname) is a deliberate re-run trigger the body never reads directly — every route change should show the chrome again and forget every scroll container's last position, regardless of what the new pathname actually is.
  useEffect(() => {
    setHidden(false);
    anchors.current = new WeakMap();
  }, [resetKey]);

  useEffect(() => {
    function onScroll(event: Event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const top = target.scrollTop;

      // A target's first-ever reading has nothing to compare against —
      // record it as this target's own baseline and commit no decision,
      // so a scroll container that mounts already scrolled (restoring a
      // saved offset, say) never reads as a sudden retract or reveal.
      if (!anchors.current.has(target)) {
        anchors.current.set(target, top);
        return;
      }

      // Batched to one decision per frame — a virtualized list can fire
      // many `scroll` events between paints; only the first one in a given
      // frame's window is what this decision compares, the rest are
      // superseded by whichever event the *next* frame's callback reads.
      if (pendingFrame.current !== null) return;
      pendingFrame.current = requestAnimationFrame(() => {
        pendingFrame.current = null;
        const anchor = anchors.current.get(target) ?? top;
        const delta = top - anchor;
        if (top <= MIN_SCROLL_TOP) {
          setHidden(false);
          anchors.current.set(target, top);
        } else if (delta > RETRACT_PX) {
          setHidden(true);
          anchors.current.set(target, top);
        } else if (delta < -REVEAL_PX) {
          setHidden(false);
          anchors.current.set(target, top);
        }
        // Otherwise: no decision, and the anchor deliberately stays put.
      });
    }

    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
    };
  }, []);

  return hidden;
}
