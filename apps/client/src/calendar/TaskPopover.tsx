import { Calendar } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../components/ui/popover.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  completeTask,
  setTaskDueDate,
  setTaskDueTime,
  uncompleteTask,
  useTask,
  useTaskList,
} from "../store/tasks.js";
import { TaskDuePicker } from "../tasks/TaskDuePicker.js";
import { formatDueDate, formatDueTime, isOverdue } from "../tasks/task-due.js";
import { closeEventPanel, useEventPanelState } from "./calendar-event-panel.js";

/**
 * The due Task's own popover (#260's own acceptance line): checkbox, title,
 * Due, Task List and Open in Tasks — no body editing offered, unlike
 * `EventEditorPopover.tsx`'s full form, since "editing the body from the
 * Calendar is not offered" is this ticket's own words. One instance mounted
 * in `CalendarRoute.tsx`, gated by the same shared panel state
 * `EventEditorPopover` reads (`calendar-event-panel.ts`) — opening either
 * popover closes the other, with no extra coordination here.
 *
 * Due is editable here, reusing `TaskDuePicker` behind the same
 * trigger-button shape `tasks/TaskEditor.tsx` already wraps it in (#261's
 * own words: "the chip's popover Due control changes the same date" — drag
 * is a shortcut, never the only path). The Due chip's own display text
 * still comes from `task-due.ts` directly rather than
 * `tasks/TaskRow.tsx#TaskDueChip` — that file's own import graph runs
 * through `TaskEditor.tsx`'s rich-text editor, a dependency this
 * body-editing-free popover has no reason to pull in for a plain label.
 *
 * `onOpenTask` rather than importing the router directly — `ReaderTaskChips.tsx`'s
 * own "stays router-agnostic" shape: the actual `navigate({ to: "/tasks/$taskId" })`
 * call lives in `CalendarRoute.tsx`, the one place that already knows it
 * lives at a route at all.
 */
export function TaskPopover({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const panel = useEventPanelState();
  const taskId = panel?.mode === "task" ? panel.taskId : null;
  const task = useTask(taskId);
  const taskList = useTaskList(task?.taskListId ?? null);
  const [dueOpen, setDueOpen] = useState(false);

  if (panel?.mode !== "task") return null;
  const anchorRect = panel.anchorRect ?? { x: window.innerWidth / 2, y: 96, width: 0, height: 0 };

  function openInTasks() {
    if (!taskId) return;
    closeEventPanel();
    onOpenTask(taskId);
  }

  function handleSetDueDate(dueDate: string | null) {
    if (!taskId) return;
    void setTaskDueDate(taskId, dueDate);
    // A Task's `dueTime` must never outlive its `dueDate` (`@mail/shared`'s
    // `taskSchema` own doc comment) — clearing the date always clears the
    // time in the same breath, `TaskEditor.tsx#handleSetDueDate`'s own rule.
    if (dueDate === null) void setTaskDueTime(taskId, null);
  }

  function handleSetDueTime(dueTime: string | null) {
    if (!taskId) return;
    void setTaskDueTime(taskId, dueTime);
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) closeEventPanel();
      }}
    >
      <PopoverAnchor asChild>
        <div
          style={{
            position: "fixed",
            left: anchorRect.x,
            top: anchorRect.y,
            width: Math.max(anchorRect.width, 1),
            height: Math.max(anchorRect.height, 1),
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>
      <PopoverContent className="calendar-task-popover" onOpenAutoFocus={(e) => e.preventDefault()}>
        <PopoverHeader>
          <PopoverTitle>Task</PopoverTitle>
        </PopoverHeader>
        {task ? (
          <>
            <div className="calendar-task-popover-row">
              <input
                type="checkbox"
                checked={task.completed}
                aria-label={
                  task.completed
                    ? `Mark "${task.title || "(untitled)"}" not done`
                    : `Mark "${task.title || "(untitled)"}" done`
                }
                onChange={() => {
                  if (task.completed) {
                    void uncompleteTask(task.id);
                  } else {
                    void completeTask(task.id);
                    announceUndoableAction("taskComplete", () => void uncompleteTask(task.id));
                  }
                  closeEventPanel();
                }}
              />
              <span className="calendar-task-popover-title">{task.title || "(untitled)"}</span>
            </div>
            <div className="calendar-task-popover-row">
              <span className="calendar-task-popover-label">Due</span>
              <Popover open={dueOpen} onOpenChange={setDueOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={`calendar-task-popover-due-btn${dueOpen ? " on" : ""}`}
                    aria-label="Due"
                  >
                    <Calendar size={14} />
                    {task.dueDate ? (
                      <span
                        className={
                          !task.completed && isOverdue(task.dueDate) ? "overdue" : undefined
                        }
                      >
                        {formatDueDate(task.dueDate)}
                        {task.dueTime ? ` ${formatDueTime(task.dueTime)}` : ""}
                      </span>
                    ) : (
                      <span>Due</span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto min-w-[220px] p-1.5">
                  <TaskDuePicker
                    dueDate={task.dueDate}
                    dueTime={task.dueTime}
                    onSetDate={handleSetDueDate}
                    onSetTime={handleSetDueTime}
                  />
                </PopoverContent>
              </Popover>
            </div>
            {taskList ? (
              <div className="calendar-task-popover-row">
                <span className="calendar-task-popover-label">Task List</span>
                <span>{taskList.name}</span>
              </div>
            ) : null}
            <div className="calendar-task-popover-actions">
              <Button type="button" size="sm" onClick={openInTasks}>
                Open in Tasks
              </Button>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
