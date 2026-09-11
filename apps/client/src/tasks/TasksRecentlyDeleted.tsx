import type { Task } from "@mail/shared";
import { Link } from "@tanstack/react-router";
import {
  type DeletedTaskListEntry,
  restoreTask,
  restoreTaskList,
  useDeletedTaskLists,
  useDeletedTasks,
} from "../store/index.js";
import "./tasks.css";

/**
 * Recently Deleted for Tasks (#257): its own screen at
 * `/tasks/recently-deleted` (`router/routes.tsx#tasksRecentlyDeletedRoute`),
 * `notes/NotesRecentlyDeleted.tsx`'s own shape — not an overlay over
 * `TasksApp`, since a deleted List or Task isn't edited from here, only
 * restored.
 *
 * Two groups, each its own entry shape (the ticket's own "Deleting a Task
 * List takes its Tasks with it in one intent, so Recently Deleted lists
 * *one* entry for the List"): every soft-deleted Task List first (each with
 * the Task count it took and a single Restore bringing back the List *and*
 * every one of those Tasks), then every Task deleted on its own — a Task
 * whose own List is also deleted never appears twice, `store/tasks.ts
 * #readDeletedTasks`'s own filter already excludes it from this second
 * group.
 */
export function TasksRecentlyDeleted() {
  const deletedLists = useDeletedTaskLists();
  const deletedTasks = useDeletedTasks();
  const nothingDeleted =
    deletedLists && deletedTasks && deletedLists.length === 0 && deletedTasks.length === 0;

  return (
    <section className="tasks-recently-deleted" aria-label="Recently Deleted">
      <div className="tasks-recently-deleted-header">
        <Link to="/tasks" className="tasks-recently-deleted-back">
          ← Tasks
        </Link>
        <h2 className="tasks-recently-deleted-title">Recently Deleted</h2>
      </div>
      {nothingDeleted ? (
        <p className="tasks-main-empty">Nothing here.</p>
      ) : (
        <>
          {deletedLists && deletedLists.length > 0 ? (
            <ul className="tasks-recently-deleted-list">
              {deletedLists.map((entry) => (
                <DeletedTaskListRow key={entry.list.id} entry={entry} />
              ))}
            </ul>
          ) : null}
          {deletedTasks && deletedTasks.length > 0 ? (
            <ul className="tasks-recently-deleted-list">
              {deletedTasks.map((task) => (
                <DeletedTaskRow key={task.id} task={task} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

function DeletedTaskListRow({ entry }: { entry: DeletedTaskListEntry }) {
  const { list, taskIds } = entry;
  const count = taskIds.length;
  return (
    <li className="tasks-recently-deleted-row">
      <span className="tasks-recently-deleted-row-title">
        {list.name} ({count} {count === 1 ? "task" : "tasks"})
      </span>
      <button
        type="button"
        className="tasks-recently-deleted-restore"
        onClick={() => void restoreTaskList(list.id, taskIds)}
      >
        Restore "{list.name}"
      </button>
    </li>
  );
}

function DeletedTaskRow({ task }: { task: Task }) {
  return (
    <li className="tasks-recently-deleted-row">
      <span className="tasks-recently-deleted-row-title">{task.title}</span>
      <button
        type="button"
        className="tasks-recently-deleted-restore"
        onClick={() => void restoreTask(task.id)}
      >
        Restore "{task.title}"
      </button>
    </li>
  );
}
