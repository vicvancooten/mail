import { Link } from "@tanstack/react-router";
import { Mark } from "../brand/Mark.js";

/**
 * The Hub's home mark (#96, grill Q20/Q26/Q35–Q37): the postmark plus the
 * "Wicket" wordmark, a real `Link` to `/mail`. Before this ticket the mark
 * doubled as `AppSwitcher.tsx`'s own toggle — clicking it never went
 * anywhere, and there was no product name anywhere signed in. Split out so
 * "click the mark to go home" and "open the switcher" are two separate
 * controls, side by side in `RootLayout.tsx`'s `header-left`, matching the
 * ticket's own acceptance box.
 */
export function HomeLink() {
  return (
    <Link to="/mail" className="home-link" aria-label="Wicket home">
      <span className="hub-mark">
        <Mark size={21} stroke />
      </span>
      <span className="wordmark">Wicket</span>
    </Link>
  );
}
