import * as React from "react";

const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

/**
 * True on a device whose primary pointer can hover and lands precisely — a
 * mouse or trackpad — false on a touch-only pointer, regardless of viewport
 * width (#134): a tablet with a mouse keeps hover-only affordances (the row
 * Done glyph, the Group Done node, bulk actions, the Timeline Spine) at any
 * width, and a phone in landscape does not gain them by growing past a
 * breakpoint. Mirrors `useIsPhoneWidth`'s own posture, but reads pointer/hover
 * capability rather than viewport width.
 *
 * Defaults to `true` (today's hover-revealed behavior) wherever
 * `matchMedia` itself is unavailable — jsdom (this repo's test
 * environment) has no real `(hover: hover)`/`(pointer: fine)` semantics of
 * its own, only whatever `window.matchMedia` a test stubs in, so a test
 * drives this hook by stubbing `matchMedia`, never by resizing the
 * viewport.
 */
export function useHoverCapable(): boolean {
  const [hoverCapable, setHoverCapable] = React.useState<boolean>(
    () => window.matchMedia?.(HOVER_QUERY).matches ?? true,
  );

  React.useEffect(() => {
    const mql = window.matchMedia?.(HOVER_QUERY);
    if (!mql) return;
    const onChange = () => setHoverCapable(mql.matches);
    mql.addEventListener("change", onChange);
    setHoverCapable(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return hoverCapable;
}
