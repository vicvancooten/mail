import type { Task } from "@mail/shared";
import type { DragEvent } from "react";
import { TaskEditor } from "./TaskEditor.js";
import { TaskThreadLinkChip } from "./TaskThreadLinkChip.js";
import { formatDueDate, formatDueTime, isOverdue } from "./task-due.js";

/**
 * One Task row (#252, expanding in place since #253): a checkbox, a title
 * and — only where it exists — a due chip, all summarized on one line when
 * collapsed. Clicking the title expands the row into `TaskEditor` in place
 * — "opening a Task means expanding its row in place... the full Task,
 * edited where it sits" (#253's own words) — never a second surface, and
 * never the checkbox: that toggle is its own control, a sibling of the
 * title button rather than something it's nested inside of, so a checkbox
 * click can never bubble into it.
 *
 * "Only one row is expanded at a time" (#253's own acceptance line) is
 * `TaskListView.tsx`'s own job — this component only ever renders what it's
 * told: collapsed, or expanded with `TaskEditor` mounted in place of the
 * summary button.
 */
export function TaskRow({
  task,
  completing = false,
  expanded,
  draggable = false,
  dragging = false,
  onToggleComplete,
  onToggleExpand,
  onCollapse,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  task: Task;
  /** True for the brief window between a checkbox tick and the row's own removal from the active group (`TaskListView.tsx`'s own animate-out) — applies the fade/slide class without changing anything else about the row. */
  completing?: boolean;
  /** Whether this row is `TaskListView.tsx`'s own current `expandedTaskId`. */
  expanded: boolean;
  /** Manual order (#255): a row is draggable while active and collapsed — `TaskListView.tsx` never sets this for a completed row, which sorts by `completedAt` instead. */
  draggable?: boolean;
  /** This row is the one currently being dragged — dims it in place, `tasks.css#.task-row--dragging`. */
  dragging?: boolean;
  onToggleComplete: () => void;
  /** Fired by the collapsed summary's title button — expands this row (and, via the parent's single `expandedTaskId`, collapses whatever else was open). */
  onToggleExpand: () => void;
  /** Fired by `TaskEditor`'s own collapse control and its Delete button — collapses this row without touching any other. */
  onCollapse: () => void;
  onDragStart?: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLLIElement>) => void;
  onDragOver?: (event: DragEvent<HTMLLIElement>) => void;
  onDrop?: (event: DragEvent<HTMLLIElement>) => void;
}) {
  return (
    <li
      id={`task-row-${task.id}`}
      className={`task-row${task.completed ? " task-row--done" : ""}${completing ? " task-row--completing" : ""}${expanded ? " task-row--expanded" : ""}${dragging ? " task-row--dragging" : ""}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {expanded ? (
        <>
          <div className="task-row-summary">
            <input
              type="checkbox"
              checked={task.completed}
              aria-label={
                task.completed ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`
              }
              className="task-row-check"
              onChange={onToggleComplete}
            />
            <button
              type="button"
              className="task-row-collapse"
              aria-label={`Collapse "${task.title}"`}
              aria-expanded="true"
              onClick={onCollapse}
            >
              {task.title || "(untitled)"}
            </button>
          </div>
          <TaskEditor taskId={task.id} onCollapse={onCollapse} />
        </>
      ) : (
        <>
          <input
            type="checkbox"
            checked={task.completed}
            aria-label={
              task.completed ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`
            }
            className="task-row-check"
            onChange={onToggleComplete}
          />
          <button
            type="button"
            className="task-row-title"
            aria-expanded="false"
            onClick={onToggleExpand}
          >
            {task.title}
          </button>
          {task.dueDate ? (
            <TaskDueChip dueDate={task.dueDate} dueTime={task.dueTime} completed={task.completed} />
          ) : null}
          {task.threadLink ? <TaskThreadLinkChip threadLink={task.threadLink} /> : null}
        </>
      )}
    </li>
  );
}

/**
 * The row's own due chip — overdue (a live-still, unfinished Task whose due
 * day has passed) in the app's danger token, `mail.css`'s own
 * `--color-danger` (`--destructive` here). `dueDate` is a zone-less day and
 * `dueTime`, when set, a floating wall-clock time (#253, `@mail/shared`'s
 * `taskSchema` own doc comment) — both rendered with `task-due.ts`'s own
 * zone-forced formatters, never a bare local `Date`/`Intl` call. Exported
 * for `mail/ReaderTaskChips.tsx` (#259), which needs this exact chip and
 * nothing else of `TaskRow`'s own row chrome.
 */
export function TaskDueChip({
  dueDate,
  dueTime,
  completed,
}: {
  dueDate: string;
  dueTime: string | null;
  completed: boolean;
}) {
  const overdue = !completed && isOverdue(dueDate);
  return (
    <span className={`task-due-chip${overdue ? " task-due-chip--overdue" : ""}`}>
      {formatDueDate(dueDate)}
      {dueTime ? ` ${formatDueTime(dueTime)}` : ""}
    </span>
  );
}
