import { completeTask, uncompleteTask, useOpenTasksForThread } from "../store/index.js";
import { TaskDueChip } from "../tasks/TaskRow.js";
import { announceUndoableAction } from "./undo-toast.js";

/**
 * The Reader's own Task chips (#259): one chip per open Task whose Thread
 * Link **field** — never a Thread Link block sitting in the body,
 * `store/tasks.ts#readOpenTasksForThread`'s own doc comment — names the
 * open Thread, read straight off the Local Cache (`useOpenTasksForThread`):
 * no request, no search index, no server-side join, so this renders in the
 * same frame the Thread itself does. Nothing at all renders while the
 * query is still settling or comes back empty — "a Thread with no open
 * Tasks shows nothing at all, not an empty affordance" (the ticket's own
 * words) draws no line between those two states.
 *
 * A chip's checkbox completes the Task optimistically with the same Undo
 * toast `tasks/TaskListView.tsx#toggleComplete` raises — `completeTask` has
 * no "uncomplete" branch here, unlike that row's own checkbox, since a chip
 * only ever shows an open Task in the first place. The completed Task drops
 * out of this list on the next Local Cache read, no animate-out of its own
 * (`TaskListView.tsx`'s fade is that view's own chrome, not something this
 * chip row repeats).
 *
 * The title is a plain button rather than a router `Link` — `onOpenTask`
 * (threaded down from `router/MailRoute.tsx`/`router/StreamRoute.tsx`, the
 * same "one place that knows [it] lives at a route at all" shape
 * `MailRoute.tsx#onNoteCreated` already gives Notes) is what actually calls
 * `navigate({ to: "/tasks/$taskId" })`, so `ThreadDetailPane` and everything
 * that hosts it (`MailSection`, `stream/StreamStack.tsx`) stays
 * router-agnostic, `MailSection.tsx`'s own tests' own invariant ("every one
 * of its own tests renders it bare, with no router present").
 */
export function ReaderTaskChips({
  threadId,
  onOpenTask,
}: {
  threadId: string;
  onOpenTask: (taskId: string) => void;
}) {
  const tasks = useOpenTasksForThread(threadId);
  if (!tasks || tasks.length === 0) return null;

  return (
    <ul className="reader-task-chips" aria-label="Tasks linked to this thread">
      {tasks.map((task) => (
        <li key={task.id} className="reader-task-chip">
          <input
            type="checkbox"
            checked={false}
            aria-label={`Mark "${task.title || "(untitled)"}" done`}
            className="reader-task-chip-check"
            onChange={() => {
              void completeTask(task.id);
              announceUndoableAction("taskComplete", () => void uncompleteTask(task.id));
            }}
          />
          <button
            type="button"
            className="reader-task-chip-title"
            onClick={() => onOpenTask(task.id)}
          >
            {task.title || "(untitled)"}
          </button>
          {task.dueDate ? (
            <TaskDueChip dueDate={task.dueDate} dueTime={task.dueTime} completed={false} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
