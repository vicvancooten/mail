import { useEffect } from "react";
import { openEditPanel } from "../calendar/calendar-event-panel.js";
import { calendarEventRoute } from "./routes.js";

/**
 * `/calendar/$eventKey`'s own route component (#233): the open Event *is*
 * the URL's path segment (`<seriesId>@<originalStart>`, this ticket's own
 * acceptance line) — `NoteDialogRoute.tsx`'s own "the one place that knows
 * this screen lives at a route at all" shape, adapted for a screen
 * (`EventEditorPopover`, mounted once in `CalendarRoute.tsx`) that is not
 * itself router-driven. This component renders nothing: it only opens the
 * shared panel at the matched `eventKey`, with no anchor rect (`null`) since
 * a deep link has no click point to anchor to — `EventEditorPopover.tsx`'s
 * own fallback centers it instead.
 *
 * `calendarEventRoute`'s own `beforeLoad` (`routes.tsx`) already redirected
 * to `/calendar` for an `eventKey` that resolves to nothing, so by the time
 * this mounts the id is known good.
 */
export function CalendarEventRoute() {
  const { eventKey } = calendarEventRoute.useParams();
  useEffect(() => {
    openEditPanel(eventKey, null);
  }, [eventKey]);
  return null;
}
