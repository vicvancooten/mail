import type { Calendar, Event, RegionFormatSettings, Task } from "@mail/shared";
import { formatHourLabel } from "@mail/shared";
import type { MouseEvent } from "react";
import { CalendarDayCell } from "./CalendarDayCell.js";
import { defaultCalendarId, openCreatePanelForDay } from "./calendar-create.js";
import { type CivilDate, dayKey, isSameDay, today, weekdayLabel } from "./calendar-dates.js";
import { openCreatePanel, pointAnchorRect } from "./calendar-event-panel.js";
import { type DayBucket, eventEnd, eventStart, minutesOfDay } from "./calendar-occurrences.js";
import { rescheduleTaskTo } from "./calendar-task-drag.js";
import { EventChip } from "./EventChip.js";
import { TaskChip } from "./TaskChip.js";

/** The default duration a plain click-to-create seeds — the User adjusts it in the popover before saving (#233). */
const DEFAULT_NEW_EVENT_DURATION_MS = 60 * 60 * 1000;

const MINUTES_PER_DAY = 24 * 60;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface TimedPlacement {
  event: Event;
  top: number; // percent
  height: number; // percent
  column: number;
  columnCount: number;
}

/**
 * Lays out one day's timed Occurrences: sorted by start, each placed in the
 * first column whose last-placed Occurrence has already ended — the
 * ordinary "interval graph colouring" greedy layout every day-grid uses for
 * side-by-side overlaps, rather than letting two overlapping meetings
 * render fully on top of each other.
 */
function layoutTimedEvents(events: readonly Event[], timeZone: string): TimedPlacement[] {
  const items = events
    .map((event) => {
      const start = minutesOfDay(eventStart(event, timeZone));
      const rawEnd = minutesOfDay(eventEnd(event, timeZone));
      const end = Math.max(rawEnd > start ? rawEnd : start + 30, start + 15);
      return { event, start, end };
    })
    .sort((left, right) => left.start - right.start);

  const columns: { end: number }[] = [];
  const placed = items.map((item) => {
    let column = columns.findIndex((col) => col.end <= item.start);
    if (column === -1) {
      column = columns.length;
      columns.push({ end: item.end });
    } else {
      columns[column] = { end: item.end };
    }
    return { ...item, column };
  });
  const columnCount = Math.max(columns.length, 1);
  return placed.map((item) => ({
    event: item.event,
    top: (item.start / MINUTES_PER_DAY) * 100,
    height: ((item.end - item.start) / MINUTES_PER_DAY) * 100,
    column: item.column,
    columnCount,
  }));
}

/**
 * The shared hour-grid behind Day, Work Week and Week (#231) — one, two or
 * five/seven day columns over the same 24-hour rail; the three views differ
 * only in how many `days` they hand this component (`calendar-url.ts#daysForView`),
 * never in a separate implementation each. Each day is its own self-
 * contained block (heading + all-day row + hour rail) so the phone
 * breakpoint (`calendar.css`) can stack them into one column instead of
 * cropping days off a fixed-column grid — "the same views at one column"
 * (#231's own acceptance line), not a narrower slice of the same view.
 */
export function DayTimeGrid({
  days,
  buckets,
  taskBuckets,
  calendarById,
  onOpenDay,
  region,
}: {
  days: readonly CivilDate[];
  buckets: ReadonlyMap<string, DayBucket>;
  /** Due Tasks (#260), keyed the same as `buckets` — `undefined` when the "Tasks" row is hidden. Never touches the timed grid below (ADR-0030). */
  taskBuckets?: ReadonlyMap<string, Task[]>;
  calendarById: ReadonlyMap<string, Calendar>;
  onOpenDay: (date: CivilDate) => void;
  /** Region Settings + Home Time Zone (#303) — the hour rail, the weekday heading and every `EventChip`'s own time label all route through this. */
  region: RegionFormatSettings;
}) {
  const now = today();
  const locale = region.locale || undefined;

  return (
    <div className={`calendar-time-grid${days.length === 1 ? " single-day" : ""}`}>
      {days.map((day) => {
        const bucket = buckets.get(dayKey(day));
        const placements = layoutTimedEvents(bucket?.timed ?? [], region.timeZone);
        const isToday = isSameDay(day, now);
        return (
          <div key={dayKey(day)} className="calendar-time-grid-day">
            <div className={`calendar-time-grid-day-heading${isToday ? " today" : ""}`}>
              <span className="calendar-weekday-label">{weekdayLabel(day, locale)}</span>
              <span className="calendar-day-number">{day.day}</span>
            </div>
            <CalendarDayCell
              date={day}
              className="calendar-all-day-cell"
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
              {(bucket?.allDay ?? []).map((event) => (
                <EventChip
                  key={event.id}
                  event={event}
                  calendar={calendarById.get(event.calendarId)}
                  variant="all-day"
                  region={region}
                />
              ))}
              {(taskBuckets?.get(dayKey(day)) ?? []).map((task) => (
                <TaskChip key={task.id} task={task} variant="all-day" />
              ))}
            </CalendarDayCell>
            <div className="calendar-time-grid-day-body">
              <div className="calendar-time-gutter">
                {HOURS.map((hour) => (
                  <div key={hour} className="calendar-hour-label">
                    {formatHourLabel(hour, region)}
                  </div>
                ))}
              </div>
              <CalendarDayCell
                date={day}
                className={`calendar-time-grid-column${isToday ? " today" : ""}`}
                onOpenDay={onOpenDay}
              >
                {HOURS.map((hour) => {
                  function createAt(x: number, y: number) {
                    const calendarId = defaultCalendarId(calendarById);
                    if (!calendarId) return;
                    const start = new Date(day.year, day.month - 1, day.day, hour, 0, 0, 0);
                    const end = new Date(start.getTime() + DEFAULT_NEW_EVENT_DURATION_MS);
                    openCreatePanel({
                      calendarId,
                      start: start.toISOString(),
                      end: end.toISOString(),
                      allDay: false,
                      anchorRect: pointAnchorRect(x, y),
                    });
                  }
                  return (
                    <button
                      key={hour}
                      type="button"
                      aria-label={`Create event at ${formatHourLabel(hour, region)}`}
                      className="calendar-hour-row"
                      onClick={(event: MouseEvent<HTMLButtonElement>) =>
                        createAt(event.clientX, event.clientY)
                      }
                    />
                  );
                })}
                {placements.map(({ event, top, height, column, columnCount }) => (
                  <div
                    key={event.id}
                    className="calendar-timed-event"
                    style={{
                      top: `${top}%`,
                      height: `${height}%`,
                      left: `${(column / columnCount) * 100}%`,
                      width: `${100 / columnCount}%`,
                    }}
                  >
                    <EventChip
                      event={event}
                      calendar={calendarById.get(event.calendarId)}
                      region={region}
                    />
                  </div>
                ))}
              </CalendarDayCell>
            </div>
          </div>
        );
      })}
    </div>
  );
}
