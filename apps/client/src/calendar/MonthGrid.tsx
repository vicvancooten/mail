import type { Calendar } from "@mail/shared";
import { CalendarDayCell } from "./CalendarDayCell.js";
import { type CivilDate, dayKey, isSameDay, today, weekdayLabel } from "./calendar-dates.js";
import type { DayBucket } from "./calendar-occurrences.js";
import { EventChip } from "./EventChip.js";

const MAX_CHIPS_PER_CELL = 3;

/**
 * Month view: a stable 6-week (42-cell) rectangle (`calendar-url.ts#daysForView`'s
 * own doc comment) so a short February and a long January read as the same
 * shape — a day cell outside the anchor month is still a real, clickable
 * cell (right-click still zooms to Day), just dimmed via `.other-month`.
 */
export function MonthGrid({
  anchorMonth,
  days,
  buckets,
  calendarById,
  onOpenDay,
}: {
  anchorMonth: number;
  days: readonly CivilDate[];
  buckets: ReadonlyMap<string, DayBucket>;
  calendarById: ReadonlyMap<string, Calendar>;
  onOpenDay: (date: CivilDate) => void;
}) {
  const now = today();
  const weekdayHeadings = days.slice(0, 7);

  return (
    <div className="calendar-month-grid">
      <div className="calendar-month-grid-weekdays">
        {weekdayHeadings.map((day) => (
          <div key={dayKey(day)} className="calendar-month-weekday">
            {weekdayLabel(day)}
          </div>
        ))}
      </div>
      <div className="calendar-month-grid-cells">
        {days.map((day) => {
          const bucket = buckets.get(dayKey(day));
          const chips = [...(bucket?.allDay ?? []), ...(bucket?.timed ?? [])];
          const overflow = chips.length - MAX_CHIPS_PER_CELL;
          return (
            <CalendarDayCell
              key={dayKey(day)}
              date={day}
              className={[
                "calendar-month-cell",
                day.month === anchorMonth ? "" : "other-month",
                isSameDay(day, now) ? "today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onOpenDay={onOpenDay}
            >
              <button
                type="button"
                className="calendar-month-day-number"
                onClick={() => onOpenDay(day)}
              >
                {day.day}
              </button>
              <div className="calendar-month-cell-chips">
                {chips.slice(0, MAX_CHIPS_PER_CELL).map((event) => (
                  <EventChip
                    key={event.id}
                    event={event}
                    calendar={calendarById.get(event.calendarId)}
                    variant="block"
                  />
                ))}
                {overflow > 0 ? (
                  <span className="calendar-month-cell-overflow">+{overflow} more</span>
                ) : null}
              </div>
            </CalendarDayCell>
          );
        })}
      </div>
    </div>
  );
}
