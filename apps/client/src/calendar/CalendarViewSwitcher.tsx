import { Segmented } from "../components/Segmented.js";
import { CALENDAR_VIEWS, type CalendarView } from "./calendar-url.js";

const VIEW_LABEL: Record<CalendarView, string> = {
  day: "Day",
  workweek: "Work Week",
  week: "Week",
  month: "Month",
  year: "Year",
};

const VIEW_OPTIONS = CALENDAR_VIEWS.map((view) => ({ value: view, label: VIEW_LABEL[view] }));

/**
 * The compact segmented view switcher (#231's own acceptance line, Variant B
 * per #173): `Segmented` (R2, `docs/design/polish-pass.md`), the app's one
 * shared "pick one view" control — this used to hand-roll its own pill of
 * plain buttons; now it shares that shape and its sliding thumb with every
 * other Segmented in the app.
 */
export function CalendarViewSwitcher({
  view,
  onChange,
}: {
  view: CalendarView;
  onChange: (view: CalendarView) => void;
}) {
  return (
    <Segmented options={VIEW_OPTIONS} value={view} onChange={onChange} label="Calendar view" />
  );
}
