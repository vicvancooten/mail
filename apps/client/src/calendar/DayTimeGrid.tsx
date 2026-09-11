import type { Calendar, Event } from "@mail/shared";
import type { MouseEvent } from "react";
import { CalendarDayCell } from "./CalendarDayCell.js";
import { type CivilDate, dayKey, isSameDay, today, weekdayLabel } from "./calendar-dates.js";
import { openCreatePanel, pointAnchorRect } from "./calendar-event-panel.js";
import { type DayBucket, eventEnd, eventStart, minutesOfDay } from "./calendar-occurrences.js";
import { EventChip } from "./EventChip.js";

/** The default duration a plain click-to-create seeds — the User adjusts it in the popover before saving (#233). */
const DEFAULT_NEW_EVENT_DURATION_MS = 60 * 60 * 1000;

function defaultCalendarId(calendarById: ReadonlyMap<string, Calendar>): string | null {
  const all = [...calendarById.values()];
  return (all.find((calendar) => calendar.isDefault) ?? all[0])?.id ?? null;
}

const MINUTES_PER_DAY = 24 * 60;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const HOUR_LABEL = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

function hourLabel(hour: number): string {
  return HOUR_LABEL.format(new Date(2000, 0, 1, hour));
}

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
function layoutTimedEvents(events: readonly Event[]): TimedPlacement[] {
  const items = events
    .map((event) => {
      const start = minutesOfDay(eventStart(event));
      const rawEnd = minutesOfDay(eventEnd(event));
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
  calendarById,
  onOpenDay,
}: {
  days: readonly CivilDate[];
  buckets: ReadonlyMap<string, DayBucket>;
  calendarById: ReadonlyMap<string, Calendar>;
  onOpenDay: (date: CivilDate) => void;
}) {
  const now = today();

  return (
    <div className={`calendar-time-grid${days.length === 1 ? " single-day" : ""}`}>
      {days.map((day) => {
        const bucket = buckets.get(dayKey(day));
        const placements = layoutTimedEvents(bucket?.timed ?? []);
        const isToday = isSameDay(day, now);
        return (
          <div key={dayKey(day)} className="calendar-time-grid-day">
            <div className={`calendar-time-grid-day-heading${isToday ? " today" : ""}`}>
              <span className="calendar-weekday-label">{weekdayLabel(day)}</span>
              <span className="calendar-day-number">{day.day}</span>
            </div>
            <CalendarDayCell date={day} className="calendar-all-day-cell" onOpenDay={onOpenDay}>
              {(bucket?.allDay ?? []).map((event) => (
                <EventChip
                  key={event.id}
                  event={event}
                  calendar={calendarById.get(event.calendarId)}
                  variant="all-day"
                />
              ))}
            </CalendarDayCell>
            <div className="calendar-time-grid-day-body">
              <div className="calendar-time-gutter">
                {HOURS.map((hour) => (
                  <div key={hour} className="calendar-hour-label">
                    {hourLabel(hour)}
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
                      aria-label={`Create event at ${hourLabel(hour)}`}
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
                    <EventChip event={event} calendar={calendarById.get(event.calendarId)} />
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
