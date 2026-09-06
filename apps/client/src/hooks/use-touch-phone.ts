import * as React from "react";

/** Matches `mail.css`'s own phone breakpoint (Split collapses to one pane, the folder rail becomes a sheet) below this width. */
const PHONE_BREAKPOINT = 700;

/**
 * "Touch-capable phone" (#143, #133's Reader-actions decision): narrow
 * enough that the Client has already dropped desktop layout (`mail.css`'s
 * 700px breakpoint) *and* the primary pointer is coarse — a mouse-driven
 * window narrowed to the same width keeps the Reader's prev/next buttons; a
 * phone loses them so the header has room for the subject (swipe and
 * Auto-advance carry the User on instead; desktop's own prev/next placement
 * is #155's to decide).
 *
 * A single combined query rather than two hooks: what the Reader cares about
 * is the conjunction, not either alone, and one `matchMedia` is one thing a
 * test needs to stub. jsdom (this repo's test environment) has no
 * `matchMedia` at all by default — same "best-effort, falls back to a
 * default" posture `hooks/use-mobile.ts`'s own read already takes — so with
 * nothing stubbed this reports `false`, unchanged from before this hook
 * existed.
 */
export function useTouchCapablePhone(): boolean {
  const [phone, setPhone] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia?.(`(max-width: ${PHONE_BREAKPOINT}px) and (pointer: coarse)`);
    if (!mql) return;
    const onChange = () => setPhone(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return phone;
}
