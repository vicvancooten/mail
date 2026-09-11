import type { Calendar, Event, Task } from "@mail/shared";
import { CalendarDayCell } from "./CalendarDayCell.js";
import { openCreatePanelForDay } from "./calendar-create.js";
import { type CivilDate, dayKey, isSameDay, today, weekdayLabel } from "./calendar-dates.js";
import { pointAnchorRect } from "./calendar-event-panel.js";
import type { DayBucket } from "./calendar-occurrences.js";
import { rescheduleTaskTo } from "./calendar-task-drag.js";
import { EventChip } from "./EventChip.js";
import { TaskChip } from "./TaskChip.js";

const MAX_CHIPS_PER_CELL = 3;

/** One Month cell's chip list mixes Events and due Tasks (#260) — tagged so the render loop below knows which chip component each entry needs. */
type MonthCellChip = { kind: "event"; event: Event } | { kind: "task"; task: Task };

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
  taskBuckets,
  calendarById,
  onOpenDay,
}: {
  anchorMonth: number;
  days: readonly CivilDate[];
  buckets: ReadonlyMap<string, DayBucket>;
  /** Due Tasks (#260), keyed the same as `buckets` — `undefined` when the "Tasks" row is hidden. */
  taskBuckets?: ReadonlyMap<string, Task[]>;
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
          // Tasks first: `+N more` has no way to reveal a chip it swallowed
          // (Month has no expandable day-cell popover of its own), so a busy
          // day's Events must never be the reason a due Task silently stops
          // rendering — "renders as a chip ... in the day cell in Month"
          // (#260's own acceptance line) is a Task's guarantee, not a
          // best-effort one Events get to crowd out.
          const chips: MonthCellChip[] = [
            ...(taskBuckets?.get(dayKey(day)) ?? []).map(
              (task): MonthCellChip => ({ kind: "task", task }),
            ),
            ...(bucket?.allDay ?? []).map((event): MonthCellChip => ({ kind: "event", event })),
            ...(bucket?.timed ?? []).map((event): MonthCellChip => ({ kind: "event", event })),
          ];
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
              onTaskDrop={(taskId) => void rescheduleTaskTo(taskId, day)}
              onBackgroundClick={(event) =>
                openCreatePanelForDay(
                  day,
                  calendarById,
                  pointAnchorRect(event.clientX, event.clientY),
                )
              }
            >
              <button
                type="button"
                className="calendar-month-day-number"
                onClick={() => onOpenDay(day)}
              >
                {day.day}
              </button>
              <div className="calendar-month-cell-chips">
                {chips
                  .slice(0, MAX_CHIPS_PER_CELL)
                  .map((chip) =>
                    chip.kind === "event" ? (
                      <EventChip
                        key={chip.event.id}
                        event={chip.event}
                        calendar={calendarById.get(chip.event.calendarId)}
                        variant="block"
                      />
                    ) : (
                      <TaskChip key={chip.task.id} task={chip.task} variant="block" />
                    ),
                  )}
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
