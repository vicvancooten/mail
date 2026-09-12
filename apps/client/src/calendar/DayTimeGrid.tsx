import type { Calendar, Event, Task } from "@mail/shared";
import { type MouseEvent, type PointerEvent, useRef, useState } from "react";
import { CalendarDayCell } from "./CalendarDayCell.js";
import { defaultCalendarId, openCreatePanelForDay } from "./calendar-create.js";
import {
  type CivilDate,
  dayKey,
  isSameDay,
  parseDayKey,
  today,
  weekdayLabel,
} from "./calendar-dates.js";
import { handleEventDrop, isDraggableCalendar, snapToQuarterHour } from "./calendar-event-drag.js";
import { openCreatePanel, pointAnchorRect } from "./calendar-event-panel.js";
import { type DayBucket, eventEnd, eventStart, minutesOfDay } from "./calendar-occurrences.js";
import { rescheduleTaskTo } from "./calendar-task-drag.js";
import { EventChip } from "./EventChip.js";
import { TaskChip } from "./TaskChip.js";

/** The default duration a plain click-to-create seeds — the User adjusts it in the popover before saving (#233). */
const DEFAULT_NEW_EVENT_DURATION_MS = 60 * 60 * 1000;

const MINUTES_PER_DAY = 24 * 60;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const HOUR_LABEL = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

/** How far a pointer has to travel before a chip's own pointer-down counts as a drag (#305) rather than the click `EventChip` already opens its editor with — a few px of jitter on an ordinary click must never start one. */
const DRAG_THRESHOLD_PX = 4;

function hourLabel(hour: number): string {
  return HOUR_LABEL.format(new Date(2000, 0, 1, hour));
}

function clampMinutes(minutes: number): number {
  return Math.min(Math.max(minutes, 0), MINUTES_PER_DAY - 1);
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

interface DragTracker {
  pointerId: number;
  event: Event;
  calendar: Calendar | undefined;
  startX: number;
  startY: number;
  moved: boolean;
  /** Live, read on pointer-up — never `preview` state, which can lag a render behind a fast final move. */
  target: { dayKey: string; minutes: number } | null;
}

/** Which day column's own rect the pointer currently sits over — nearest column wins once the pointer strays past the grid's own left/right edge, so a drag dropped past the last day column still lands on it rather than doing nothing. */
function columnAt(
  clientX: number,
  columns: ReadonlyMap<string, HTMLDivElement>,
): { dayKey: string; el: HTMLDivElement } | null {
  let nearest: { dayKey: string; el: HTMLDivElement } | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [key, el] of columns) {
    const rect = el.getBoundingClientRect();
    if (clientX >= rect.left && clientX < rect.right) return { dayKey: key, el };
    const distance = Math.min(Math.abs(clientX - rect.left), Math.abs(clientX - rect.right));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = { dayKey: key, el };
    }
  }
  return nearest;
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
 *
 * Dragging a timed Occurrence (#305): pointer down/move/up on a chip, native
 * Pointer Events — no HTML5 drag-and-drop, no library — snapping to the
 * nearest quarter hour and, in Week/Work Week, letting the drop land in a
 * different day column entirely (`handleEventDrop`'s own `targetDay`/
 * `targetMinutes` pair). `columnRefs` is what a pointer-move hit-tests
 * against (`columnAt`); `dragTrackerRef` is the drag's own source of truth,
 * read on pointer-up rather than the `preview` state a fast final move can
 * lag a render behind.
 */
export function DayTimeGrid({
  days,
  buckets,
  taskBuckets,
  calendarById,
  onOpenDay,
}: {
  days: readonly CivilDate[];
  buckets: ReadonlyMap<string, DayBucket>;
  /** Due Tasks (#260), keyed the same as `buckets` — `undefined` when the "Tasks" row is hidden. Never touches the timed grid below (ADR-0030). */
  taskBuckets?: ReadonlyMap<string, Task[]>;
  calendarById: ReadonlyMap<string, Calendar>;
  onOpenDay: (date: CivilDate) => void;
}) {
  const now = today();
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const dragTrackerRef = useRef<DragTracker | null>(null);
  const justDraggedRef = useRef(false);
  const [preview, setPreview] = useState<{
    eventId: string;
    dayKey: string;
    minutes: number;
    heightPercent: number;
  } | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>, occurrence: Event) {
    if (event.button !== 0) return;
    const calendar = calendarById.get(occurrence.calendarId);
    if (!isDraggableCalendar(calendar)) return;
    dragTrackerRef.current = {
      pointerId: event.pointerId,
      event: occurrence,
      calendar,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      target: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>, heightPercent: number) {
    const tracker = dragTrackerRef.current;
    if (!tracker || tracker.pointerId !== event.pointerId) return;
    if (!tracker.moved) {
      const dx = event.clientX - tracker.startX;
      const dy = event.clientY - tracker.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      tracker.moved = true;
    }
    const column = columnAt(event.clientX, columnRefs.current);
    if (!column) return;
    const rect = column.el.getBoundingClientRect();
    const minutes = snapToQuarterHour(
      clampMinutes(((event.clientY - rect.top) / rect.height) * MINUTES_PER_DAY),
    );
    tracker.target = { dayKey: column.dayKey, minutes };
    setPreview({ eventId: tracker.event.id, dayKey: column.dayKey, minutes, heightPercent });
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const tracker = dragTrackerRef.current;
    dragTrackerRef.current = null;
    if (!tracker || tracker.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setPreview(null);
    if (!tracker.moved || !tracker.target) return;
    justDraggedRef.current = true;
    const targetDay = parseDayKey(tracker.target.dayKey);
    if (!targetDay) return;
    void handleEventDrop(tracker.event, tracker.calendar, targetDay, tracker.target.minutes);
  }

  function handlePointerCancel(event: PointerEvent<HTMLDivElement>) {
    const tracker = dragTrackerRef.current;
    if (!tracker || tracker.pointerId !== event.pointerId) return;
    dragTrackerRef.current = null;
    setPreview(null);
  }

  /** Swallows the synthetic click a real drag's own pointer-up otherwise still fires — `EventChip`'s own click-to-edit is exactly what a drag must never also trigger. */
  function handleClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!justDraggedRef.current) return;
    justDraggedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div
      className={`calendar-time-grid${days.length === 1 ? " single-day" : ""}${preview ? " dragging" : ""}`}
    >
      {days.map((day) => {
        const bucket = buckets.get(dayKey(day));
        const placements = layoutTimedEvents(bucket?.timed ?? []);
        const isToday = isSameDay(day, now);
        const key = dayKey(day);
        return (
          <div key={key} className="calendar-time-grid-day">
            <div className={`calendar-time-grid-day-heading${isToday ? " today" : ""}`}>
              <span className="calendar-weekday-label">{weekdayLabel(day)}</span>
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
                />
              ))}
              {(taskBuckets?.get(key) ?? []).map((task) => (
                <TaskChip key={task.id} task={task} variant="all-day" />
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
                containerRef={(el) => {
                  if (el) columnRefs.current.set(key, el);
                  else columnRefs.current.delete(key);
                }}
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
                {placements.map(({ event, top, height, column, columnCount }) => {
                  const calendar = calendarById.get(event.calendarId);
                  const draggable = isDraggableCalendar(calendar);
                  const isDraggingThis = preview?.eventId === event.id;
                  return (
                    <div
                      key={event.id}
                      className={`calendar-timed-event${isDraggingThis ? " dragging-source" : ""}${draggable ? " draggable" : ""}`}
                      style={{
                        top: `${top}%`,
                        height: `${height}%`,
                        left: `${(column / columnCount) * 100}%`,
                        width: `${100 / columnCount}%`,
                      }}
                      onPointerDown={draggable ? (e) => handlePointerDown(e, event) : undefined}
                      onPointerMove={draggable ? (e) => handlePointerMove(e, height) : undefined}
                      onPointerUp={draggable ? handlePointerUp : undefined}
                      onPointerCancel={draggable ? handlePointerCancel : undefined}
                      onClickCapture={draggable ? handleClickCapture : undefined}
                    >
                      <EventChip event={event} calendar={calendar} />
                    </div>
                  );
                })}
                {preview && preview.dayKey === key ? (
                  <div
                    className="calendar-timed-event calendar-timed-event-ghost"
                    style={{
                      top: `${(preview.minutes / MINUTES_PER_DAY) * 100}%`,
                      height: `${preview.heightPercent}%`,
                      left: 0,
                      width: "100%",
                    }}
                  />
                ) : null}
              </CalendarDayCell>
            </div>
          </div>
        );
      })}
    </div>
  );
}
