import type { Task } from "@mail/shared";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  completeTask,
  createTask,
  newTaskId,
  setTaskDueDate,
  uncompleteTask,
  useRegionFormatSettings,
  useTaskLists,
  useUpcomingTasks,
} from "../store/index.js";
import { TaskQuickAdd } from "./TaskQuickAdd.js";
import { TaskRow } from "./TaskRow.js";
import { formatUpcomingDayHeading } from "./task-due.js";

/** `TaskListView.tsx`'s own animate-out window, reused verbatim. */
const COMPLETE_ANIMATION_MS = 260;

/**
 * Upcoming (#254): every live Task due after today, across every List,
 * grouped by day. "There is no single quick add for the view — each day
 * group carries its own" (the ticket's own words): every group renders its
 * own `TaskQuickAdd`, each creating a Task in the default List due exactly
 * that group's day, so a Task never vanishes from the group it was typed
 * into. The "N completed" expander is a single, view-wide one — a completed
 * Task's own day no longer matters once it's done, `TaskListView.tsx`'s own
 * one-expander-per-List shape carried over to one-expander-per-view here.
 */
export function TaskUpcomingView({ onBack }: { onBack: () => void }) {
  const dayGroups = useUpcomingTasks();
  const taskLists = useTaskLists();
  const region = useRegionFormatSettings();
  const [completingIds, setCompletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const defaultList = (taskLists ?? []).find((list) => list.isDefault) ?? null;

  function addTaskForDay(dueDate: string, title: string) {
    if (!defaultList) return;
    const id = newTaskId();
    const sectionId = defaultList.sections[0]?.id ?? null;
    void (async () => {
      await createTask(id, defaultList.id, sectionId, title);
      await setTaskDueDate(id, dueDate);
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

  const groups = dayGroups ?? [];
  const anyTasks = groups.some((group) => group.tasks.length > 0);
  const completed = groups
    .flatMap((group) => group.tasks)
    .filter((task) => task.completed && !completingIds.has(task.id))
    .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));

  function renderRow(task: Task) {
    return (
      <TaskRow
        key={task.id}
        task={task}
        completing={completingIds.has(task.id)}
        expanded={task.id === expandedTaskId}
        onToggleComplete={() => toggleComplete(task)}
        onToggleExpand={() =>
          setExpandedTaskId((current) => (current === task.id ? null : task.id))
        }
        onCollapse={() => setExpandedTaskId((current) => (current === task.id ? null : current))}
      />
    );
  }

  return (
    <section className="tasks-main" aria-label="Upcoming">
      <div className="tasks-main-header">
        <button
          type="button"
          className="tasks-back"
          aria-label="Back to Task Lists"
          onClick={onBack}
        >
          <ChevronLeft size={18} />
        </button>
        <h2 className="tasks-main-title">Upcoming</h2>
      </div>
      {!anyTasks ? (
        <p className="tasks-main-empty">Nothing upcoming.</p>
      ) : (
        <div className="tasks-groups">
          {groups.map((group) => {
            const active = group.tasks.filter(
              (task) => !task.completed || completingIds.has(task.id),
            );
            const heading = formatUpcomingDayHeading(group.dueDate, region);
            return (
              <div className="tasks-group" key={group.dueDate}>
                <h3 className="tasks-group-heading">{heading}</h3>
                <TaskQuickAdd
                  onAdd={(title) => addTaskForDay(group.dueDate, title)}
                  ariaLabel={`Add a task for ${heading}`}
                  placeholder="Add a task…"
                />
                {active.length > 0 ? <ul className="task-list">{active.map(renderRow)}</ul> : null}
              </div>
            );
          })}
        </div>
      )}
      {completed.length > 0 ? (
        <details className="tasks-completed-expander">
          <summary>{completed.length} completed</summary>
          <ul className="task-list">{completed.map(renderRow)}</ul>
        </details>
      ) : null}
    </section>
  );
}
