import type { Calendar, Event, Task } from "@mail/shared";
import { type MouseEvent, type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { CalendarDayCell } from "./CalendarDayCell.js";
import { openCreatePanelForDay } from "./calendar-create.js";
import {
  type CivilDate,
  dayKey,
  isSameDay,
  parseDayKey,
  today,
  weekdayLabel,
} from "./calendar-dates.js";
import { handleEventDrop, isDraggableCalendar } from "./calendar-event-drag.js";
import { pointAnchorRect } from "./calendar-event-panel.js";
import type { DayBucket } from "./calendar-occurrences.js";
import { rescheduleTaskTo } from "./calendar-task-drag.js";
import { EventChip } from "./EventChip.js";
import { TaskChip } from "./TaskChip.js";

const MAX_CHIPS_PER_CELL = 3;
/** Same jitter tolerance `DayTimeGrid.tsx` uses before a chip's pointer-down counts as a drag (#305). */
const DRAG_THRESHOLD_PX = 4;

/** One Month cell's chip list mixes Events and due Tasks (#260) — tagged so the render loop below knows which chip component each entry needs. */
type MonthCellChip = { kind: "event"; event: Event } | { kind: "task"; task: Task };

interface DragTracker {
  pointerId: number;
  event: Event;
  calendar: Calendar | undefined;
  startX: number;
  startY: number;
  moved: boolean;
  targetDayKey: string | null;
}

/** Nearest day cell to `clientX`/`clientY` — Month's own drop target has no time component (#305's own acceptance line: "snaps ... to a day in month"), so the whole cell's own rect is the hit target, not a vertical offset within it. */
function cellAt(
  clientX: number,
  clientY: number,
  cells: ReadonlyMap<string, HTMLDivElement>,
): string | null {
  let nearest: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const [key, el] of cells) {
    const rect = el.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX < rect.right &&
      clientY >= rect.top &&
      clientY < rect.bottom
    ) {
      return key;
    }
    const centerX = (rect.left + rect.right) / 2;
    const centerY = (rect.top + rect.bottom) / 2;
    const distance = Math.hypot(clientX - centerX, clientY - centerY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = key;
    }
  }
  return nearest;
}

/**
 * Month view: a stable 6-week (42-cell) rectangle (`calendar-url.ts#daysForView`'s
 * own doc comment) so a short February and a long January read as the same
 * shape — a day cell outside the anchor month is still a real, clickable
 * cell (right-click still zooms to Day), just dimmed via `.other-month`.
 *
 * Dragging a chip (#305) only ever changes its day — never its time of day,
 * "snaps ... to a day in month" (this ticket's own acceptance line) — the
 * same pointer-capture mechanics `DayTimeGrid.tsx` uses, hit-tested against
 * whole day cells (`cellAt`) rather than a vertical offset within one.
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
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const dragTrackerRef = useRef<DragTracker | null>(null);
  const justDraggedRef = useRef(false);
  const [draggingEventId, setDraggingEventId] = useState<string | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>, occurrence: Event) {
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
      targetDayKey: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const tracker = dragTrackerRef.current;
    if (!tracker || tracker.pointerId !== event.pointerId) return;
    if (!tracker.moved) {
      const dx = event.clientX - tracker.startX;
      const dy = event.clientY - tracker.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      tracker.moved = true;
      setDraggingEventId(tracker.event.id);
    }
    tracker.targetDayKey = cellAt(event.clientX, event.clientY, cellRefs.current);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const tracker = dragTrackerRef.current;
    dragTrackerRef.current = null;
    if (!tracker || tracker.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingEventId(null);
    if (!tracker.moved || !tracker.targetDayKey) return;
    justDraggedRef.current = true;
    const targetDay = parseDayKey(tracker.targetDayKey);
    if (!targetDay) return;
    void handleEventDrop(tracker.event, tracker.calendar, targetDay, null);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const tracker = dragTrackerRef.current;
    if (!tracker || tracker.pointerId !== event.pointerId) return;
    dragTrackerRef.current = null;
    setDraggingEventId(null);
  }

  /** Swallows the synthetic click a real drag's own pointer-up otherwise still fires — `EventChip`'s own click-to-edit is exactly what a drag must never also trigger. */
  function handleClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!justDraggedRef.current) return;
    justDraggedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div className={`calendar-month-grid${draggingEventId ? " dragging" : ""}`}>
      <div className="calendar-month-grid-weekdays">
        {weekdayHeadings.map((day) => (
          <div key={dayKey(day)} className="calendar-month-weekday">
            {weekdayLabel(day)}
          </div>
        ))}
      </div>
      <div className="calendar-month-grid-cells">
        {days.map((day) => {
          const key = dayKey(day);
          const bucket = buckets.get(key);
          // Tasks first: `+N more` has no way to reveal a chip it swallowed
          // (Month has no expandable day-cell popover of its own), so a busy
          // day's Events must never be the reason a due Task silently stops
          // rendering — "renders as a chip ... in the day cell in Month"
          // (#260's own acceptance line) is a Task's guarantee, not a
          // best-effort one Events get to crowd out.
          const chips: MonthCellChip[] = [
            ...(taskBuckets?.get(key) ?? []).map((task): MonthCellChip => ({ kind: "task", task })),
            ...(bucket?.allDay ?? []).map((event): MonthCellChip => ({ kind: "event", event })),
            ...(bucket?.timed ?? []).map((event): MonthCellChip => ({ kind: "event", event })),
          ];
          const overflow = chips.length - MAX_CHIPS_PER_CELL;
          return (
            <CalendarDayCell
              key={key}
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
              containerRef={(el) => {
                if (el) cellRefs.current.set(key, el);
                else cellRefs.current.delete(key);
              }}
            >
              <button
                type="button"
                className="calendar-month-day-number"
                onClick={() => onOpenDay(day)}
              >
                {day.day}
              </button>
              <div className="calendar-month-cell-chips">
                {chips.slice(0, MAX_CHIPS_PER_CELL).map((chip) => {
                  if (chip.kind === "task") {
                    return <TaskChip key={chip.task.id} task={chip.task} variant="block" />;
                  }
                  const calendar = calendarById.get(chip.event.calendarId);
                  const draggable = isDraggableCalendar(calendar);
                  return (
                    <div
                      key={chip.event.id}
                      className={`calendar-month-chip-drag${draggingEventId === chip.event.id ? " dragging-source" : ""}${draggable ? " draggable" : ""}`}
                      onPointerDown={
                        draggable ? (e) => handlePointerDown(e, chip.event) : undefined
                      }
                      onPointerMove={draggable ? handlePointerMove : undefined}
                      onPointerUp={draggable ? handlePointerUp : undefined}
                      onPointerCancel={draggable ? handlePointerCancel : undefined}
                      onClickCapture={draggable ? handleClickCapture : undefined}
                    >
                      <EventChip event={chip.event} calendar={calendar} variant="block" />
                    </div>
                  );
                })}
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
