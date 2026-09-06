import { useHoverCapable } from "./use-hover-capable.js";
import { useIsPhoneWidth } from "./use-phone-width.js";

/**
 * "Touch-capable phone" (#143, #133's Reader-actions decision): narrow
 * enough that the Client has already dropped desktop layout
 * (`useIsPhoneWidth`, #134/#138's own 700px mount/unmount breakpoint) *and*
 * the primary pointer can't hover precisely (`useHoverCapable`, #134's own
 * input-capability gate) — a mouse-driven window narrowed to the same width
 * keeps the Reader's prev/next buttons; a phone loses them so the header has
 * room for the subject (swipe and Auto-advance carry the User on instead;
 * desktop's own prev/next placement is #155's to decide).
 *
 * Composes the two hooks the rest of this epic already settled on rather
 * than a third breakpoint/capability read of its own — a test drives this
 * the same way it drives either of them, by stubbing `matchMedia`
 * (`test-support/match-media.ts`).
 */
export function useTouchCapablePhone(): boolean {
  const phoneWidth = useIsPhoneWidth();
  const hoverCapable = useHoverCapable();
  return phoneWidth && !hoverCapable;
}
