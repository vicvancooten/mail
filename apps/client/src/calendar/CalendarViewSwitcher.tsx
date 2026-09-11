import { CALENDAR_VIEWS, type CalendarView } from "./calendar-url.js";

const VIEW_LABEL: Record<CalendarView, string> = {
  day: "Day",
  workweek: "Work Week",
  week: "Week",
  month: "Month",
  year: "Year",
};

/**
 * The compact segmented view switcher (#231's own acceptance line, Variant B
 * per #173): five plain buttons in one pill-shaped track rather than a
 * shadcn `Tabs` primitive — the same "hand-rolled control, not a heavier
 * dependency" call `apps/AppSwitcher.tsx`'s own tab row already made.
 */
export function CalendarViewSwitcher({
  view,
  onChange,
}: {
  view: CalendarView;
  onChange: (view: CalendarView) => void;
}) {
  return (
    <fieldset className="calendar-view-switcher">
      <legend className="sr-only">Calendar view</legend>
      {CALENDAR_VIEWS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className={`calendar-view-switcher-btn${candidate === view ? " current" : ""}`}
          aria-pressed={candidate === view}
          onClick={() => onChange(candidate)}
        >
          {VIEW_LABEL[candidate]}
        </button>
      ))}
    </fieldset>
  );
}
