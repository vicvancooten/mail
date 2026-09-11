import type { Task } from "@mail/shared";
import type { DragEvent, MouseEvent } from "react";
import { announceUndoableAction } from "../mail/undo-toast.js";
import { completeTask, uncompleteTask } from "../store/tasks.js";
import { TASK_DRAG_TYPE } from "../tasks/task-drag.js";
import { formatDueTime, isOverdue } from "../tasks/task-due.js";
import { elementAnchorRect, openTaskPanel } from "./calendar-event-panel.js";

/**
 * One due Task, on the grid (#260) — `EventChip.tsx`'s own sibling, never
 * tinted by a Calendar's colour (a Task is not a Calendar's content) and
 * never positioned on the timed grid (ADR-0030: a Task is a deadline, not a
 * block of time) — only the all-day row (Day/Work Week/Week) and the day
 * cell (Month) ever render one. A due time, where set, is a **prefix** on
 * the chip's own label, not a position — "17:00 Renew passport", read
 * left-to-right like any other line of text.
 *
 * The checkbox is its own control, a sibling of the title rather than
 * nested inside it — `TaskRow.tsx`'s own reasoning, so a tick can never
 * also open the popover. Ticking completes the Task optimistically with
 * the same coalescing Undo toast every other completion raises
 * (`mail/ReaderTaskChips.tsx`'s own shape) — the chip itself does nothing
 * more than that; the row's own removal is just `useAllTasks`' live query
 * re-running over a Task that no longer buckets onto this day
 * (`calendar-task-occurrences.ts#bucketTasksByDay` drops a completed Task).
 *
 * Clicking the rest of the chip opens the Task popover (#260's own
 * acceptance line): checkbox, title, Due, Task List, Open in Tasks, no body
 * editing — anchored to the chip's own rect, `EventChip.tsx`'s own
 * `elementAnchorRect` convention.
 *
 * Draggable to another day (#261), native HTML5 drag — `tasks/task-drag.ts`'s
 * own `TASK_DRAG_TYPE`, the exact payload `TaskListView.tsx`'s row drag
 * already tags a dragged Task with (its own doc comment: "matching what the
 * Calendar prototype already does for Task chips"). The chip is only ever
 * the drag *source* here — `CalendarDayCell.tsx`'s `onTaskDrop` is the drop
 * side, wired per grid cell rather than here.
 */
export function TaskChip({
  task,
  variant = "block",
}: {
  task: Task;
  variant?: "all-day" | "block";
}) {
  const overdue = task.dueDate !== null && isOverdue(task.dueDate);

  function open(target: HTMLElement) {
    openTaskPanel(task.id, elementAnchorRect(target));
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a native HTML5 drag source (#261, "no drag-and-drop dependency") has no ARIA role of its own — the checkbox and the title button right inside it are the real, focusable controls; the drag is the shortcut, the chip's own popover Due control (`TaskPopover.tsx`) is the keyboard/screen-reader path (`tasks/TaskListView.tsx`'s own precedent for a drag surface layered over independently operable controls).
    <div
      className={`calendar-task-chip calendar-task-chip-${variant}${overdue ? " calendar-task-chip-overdue" : ""}`}
      draggable
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
      }}
    >
      <input
        type="checkbox"
        checked={false}
        aria-label={`Mark "${task.title || "(untitled)"}" done`}
        className="calendar-task-chip-check"
        onClick={(clickEvent: MouseEvent<HTMLInputElement>) => clickEvent.stopPropagation()}
        onChange={() => {
          void completeTask(task.id);
          announceUndoableAction("taskComplete", () => void uncompleteTask(task.id));
        }}
      />
      <button
        type="button"
        className="calendar-task-chip-title"
        title={task.title || "(untitled)"}
        onClick={(clickEvent: MouseEvent<HTMLButtonElement>) => {
          clickEvent.stopPropagation();
          open(clickEvent.currentTarget);
        }}
      >
        {task.dueTime ? (
          <span className="calendar-task-chip-time">{formatDueTime(task.dueTime)}</span>
        ) : null}
        <span className="calendar-task-chip-label">{task.title || "(untitled)"}</span>
      </button>
    </div>
  );
}
