import { ChevronDown, ChevronUp } from "lucide-react";
import { useTouchCapablePhone } from "../hooks/use-touch-phone.js";

/**
 * The Reader's prev/next, on desktop only (#155 — the redesign brief's own
 * call on where these land once #143 pulled them out of the reading-header
 * row). A small floating rail beside the pane rather than a row of icons
 * competing with the subject for space: `SplitView.tsx` renders this as a
 * flex sibling of `ThreadDetailPane`, inside `.split-pane` — see
 * `mail.css`'s own `.reader-neighbor-rail` block for why that's enough to
 * keep it in place while the Message body scrolls underneath.
 *
 * Never rendered on a touch-capable phone — the same `useTouchCapablePhone`
 * check `ThreadDetailPane`'s old inline chevrons used (#143 user story 13):
 * swipe (#150) is that surface's own equivalent. A real conditional, not
 * CSS-only visibility, on purpose — a hidden-but-focusable button is a
 * fresh a11y bug, not a neutral simplification, and List's single pane has
 * no "beside" to float this in regardless.
 */
export function ReaderNeighborRail({
  onPrev,
  onNext,
}: {
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const phone = useTouchCapablePhone();
  if (phone || (!onPrev && !onNext)) return null;
  return (
    <nav className="reader-neighbor-rail" aria-label="Adjacent threads">
      <button
        type="button"
        onClick={onPrev}
        disabled={!onPrev}
        aria-label="Previous thread"
        title="Previous thread"
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!onNext}
        aria-label="Next thread"
        title="Next thread"
      >
        <ChevronDown size={16} />
      </button>
    </nav>
  );
}
