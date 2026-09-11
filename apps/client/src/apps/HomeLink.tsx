import { Link } from "@tanstack/react-router";
import { Mark } from "../brand/Mark.js";

/**
 * The Hub's home mark (#96, grill Q20/Q26/Q35–Q37): the postmark plus the
 * "Wicket" wordmark, a real `Link`. Before #96 the mark doubled as
 * `AppSwitcher.tsx`'s own toggle — clicking it never went anywhere, and
 * there was no product name anywhere signed in. Split out so "click the mark
 * to go home" and "open the switcher" are two separate controls, side by
 * side in `RootLayout.tsx`'s `header-left`, matching the ticket's own
 * acceptance box.
 *
 * `to` defaults to `/mail` (the desktop mark's own long-standing target) but
 * `RootLayout.tsx`'s phone instance passes the current App's own root path
 * instead (#286: "home is the current App's root") — the phone top bar has
 * no adjacent App Switcher to jump elsewhere with, so its one mark has to
 * mean "back to the top of whatever App you're already in".
 */
export function HomeLink({ to = "/mail" }: { to?: string }) {
  return (
    <Link to={to} className="home-link" aria-label="Wicket home">
      <span className="hub-mark">
        <Mark size={21} stroke />
      </span>
      <span className="wordmark">Wicket</span>
    </Link>
  );
}
