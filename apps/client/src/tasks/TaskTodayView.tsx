import type { Task } from "@mail/shared";
import { useState } from "react";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  completeTask,
  createTask,
  newTaskId,
  setTaskDueDate,
  uncompleteTask,
  useTaskLists,
  useTodayTasks,
} from "../store/index.js";
import { TaskQuickAdd } from "./TaskQuickAdd.js";
import { TaskRow } from "./TaskRow.js";
import { TasksCompletedGroup } from "./TasksCompletedGroup.js";
import { dateOnlyToWireDueDate, localDateInputValue } from "./task-due.js";

/** `TaskListView.tsx`'s own animate-out window, reused verbatim so completing a Task from Today looks and behaves exactly the same. */
const COMPLETE_ANIMATION_MS = 260;

/**
 * Today (#254): every live Task due today or overdue, across every List —
 * "where overdue Tasks gather" (the ticket's own words) — one flat list
 * (`useTodayTasks` already hands back the sort this view needs, due time
 * then manual order), no Section grouping, since a cross-List view has no
 * single List's own Sections to group by. Quick add, completing a row, and
 * the "N completed" expander are `TaskListView.tsx`'s own shapes, copied
 * rather than shared: the two views read a different query but behave
 * identically once they have their own Tasks in hand.
 */
export function TaskTodayView() {
  const tasks = useTodayTasks();
  const taskLists = useTaskLists();
  const [completingIds, setCompletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // No `useTaskCompletedOpen` Device Preference here — that's keyed per
  // List (`TaskListView.tsx`'s own doc comment), and Today isn't one; a
  // plain `useState` matches the old `<details>`'s own always-starts-closed
  // behavior.
  const [completedOpen, setCompletedOpen] = useState(false);

  const defaultList = (taskLists ?? []).find((list) => list.isDefault) ?? null;

  /** "Creates in the default Task List due today" (the ticket's own words) — a create followed by its own Due patch, `TaskDuePicker.tsx`'s own two-call shape rather than a `createTask` param, since only this one caller ever needs a Due set at creation time. */
  function addTask(title: string) {
    if (!defaultList) return;
    const id = newTaskId();
    const sectionId = defaultList.sections[0]?.id ?? null;
    void (async () => {
      await createTask(id, defaultList.id, sectionId, title);
      await setTaskDueDate(id, dateOnlyToWireDueDate(localDateInputValue(new Date())));
    })();
  }

  function toggleComplete(task: Task) {
    if (task.completed) {
      void uncompleteTask(task.id);
      return;
    }
    void completeTask(task.id);
    announceUndoableAction("taskComplete", () => void uncompleteTask(task.id));
    setCompletingIds((current) => new Set(current).add(task.id));
    setTimeout(() => {
      setCompletingIds((current) => {
        if (!current.has(task.id)) return current;
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }, COMPLETE_ANIMATION_MS);
  }

  const all = tasks ?? [];
  const active = all.filter((task) => !task.completed || completingIds.has(task.id));
  const completed = all
    .filter((task) => task.completed && !completingIds.has(task.id))
    .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));

  return (
    <section className="tasks-main" aria-label="Today">
      <div className="tasks-main-header">
        <h2 className="tasks-main-title">Today</h2>
      </div>
      <TaskQuickAdd onAdd={addTask} registerFocus />
      {all.length === 0 ? (
        <p className="tasks-main-empty">Nothing due today.</p>
      ) : (
        <ul className="task-list">
          {active.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              completing={completingIds.has(task.id)}
              expanded={task.id === expandedTaskId}
              onToggleComplete={() => toggleComplete(task)}
              onToggleExpand={() =>
                setExpandedTaskId((current) => (current === task.id ? null : task.id))
              }
              onCollapse={() =>
                setExpandedTaskId((current) => (current === task.id ? null : current))
              }
            />
          ))}
        </ul>
      )}
      {completed.length > 0 ? (
        <TasksCompletedGroup
          count={completed.length}
          open={completedOpen}
          onToggle={setCompletedOpen}
        >
          {completed.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={task.id === expandedTaskId}
              onToggleComplete={() => toggleComplete(task)}
              onToggleExpand={() =>
                setExpandedTaskId((current) => (current === task.id ? null : task.id))
              }
              onCollapse={() =>
                setExpandedTaskId((current) => (current === task.id ? null : current))
              }
            />
          ))}
        </TasksCompletedGroup>
      ) : null}
    </section>
  );
}
