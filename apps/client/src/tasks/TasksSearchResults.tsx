import { X } from "lucide-react";
import { useMemo } from "react";
import { useAllTasks, useTaskLists } from "../store/index.js";
import { taskSearchText } from "./task-text.js";

/**
 * "See all results" narrowing the whole Tasks App (#262), not one List —
 * the query rides `?q=` as a read-only chip (`TasksApp.tsx`'s own doc
 * comment on why this replaces the main column regardless of
 * `selectedTaskListId`), never a search field this App grows for itself.
 * Matches every live Task across every live List (`store/tasks.ts#readAllTasks`,
 * the same read the Palette's own `TASKS_SOURCE` uses), open ones ranked
 * above completed — `local-hits.ts#TASKS_SOURCE`'s own `compare`, mirrored
 * here since this view is a second rendering of the same rule, not the
 * Palette's own capped list.
 *
 * Clicking a row opens that Task at `/tasks/:taskId` (`onOpenTask`,
 * `router/TasksRoute.tsx`) — the same route a Palette hit itself opens,
 * "expanded on its own List" rather than in place here, since a flat
 * cross-List list has nowhere in place to expand it into.
 */
export function TasksSearchResults({
  query,
  onClearQuery,
  onOpenTask,
}: {
  query: string;
  onClearQuery: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const tasks = useAllTasks();
  const taskLists = useTaskLists();
  const listNameById = useMemo(
    () => new Map((taskLists ?? []).map((list) => [list.id, list.name])),
    [taskLists],
  );

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const all = tasks ?? [];
    const filtered = needle
      ? all.filter((task) => taskSearchText(task).toLowerCase().includes(needle))
      : all;
    return [...filtered].sort((left, right) => Number(left.completed) - Number(right.completed));
  }, [tasks, needle]);

  return (
    <section className="tasks-main" aria-label="Task search results">
      <div className="tasks-search-chip-row">
        <span className="tasks-search-chip">
          {query}
          <button
            type="button"
            className="tasks-search-chip-remove"
            aria-label="Clear search"
            onClick={onClearQuery}
          >
            <X size={11} />
          </button>
        </span>
      </div>
      {matches.length === 0 ? (
        <p className="tasks-main-empty">No Tasks match &quot;{query}&quot;.</p>
      ) : (
        <ul className="task-list">
          {matches.map((task) => (
            <li key={task.id} className={`task-row${task.completed ? " task-row--done" : ""}`}>
              <button type="button" className="task-row-title" onClick={() => onOpenTask(task.id)}>
                {task.title || "(untitled)"}
              </button>
              {listNameById.get(task.taskListId) ? (
                <span className="task-due-chip">{listNameById.get(task.taskListId)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
