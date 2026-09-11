import { useCallback } from "react";
import { useTask } from "../store/index.js";
import { TasksApp } from "../tasks/TasksApp.js";
import type { TaskView } from "../tasks/task-view.js";
import { type TasksSearch, tasksRoute, tasksTaskRoute } from "./routes.js";

/** `search.view`, narrowed to a real `TaskView` — an unrecognized value (a stale bookmark, a typo) resolves the same as unset, `mailRoute`'s own tolerance for an unrecognized `folder`. */
function asTaskView(view: string | undefined): TaskView | null {
  return view === "today" || view === "upcoming" ? view : null;
}

/**
 * `/tasks`'s own route component (#252/#253, replacing `PlaceholderRoute`):
 * `MailRoute.tsx`'s own "the one place that knows [the screen] lives at a
 * route at all" shape — `TasksApp` itself takes plain callback props, no
 * router dependency of its own, so every one of its own tests renders it
 * bare (`TasksSidebar.tsx`'s own doc comment on why neither it nor
 * `TaskListView` reaches for a `Link` directly).
 *
 * The selected List rides `?list=` (`routes.tsx#TasksSearch`'s own doc
 * comment on why a search param, not `tasksListRoute`'s old path param) —
 * `search: (prev) => ({...})` on every navigate here so `?view=` (unread by
 * anything yet) survives a List change untouched, the same "don't clobber a
 * sibling search param" shape `mailRoute`'s own callers already take.
 */
export function TasksIndexRoute() {
  const search = tasksRoute.useSearch();
  const navigate = tasksRoute.useNavigate();
  const onSelectTaskList = useCallback(
    (id: string) => {
      void navigate({
        to: "/tasks",
        search: (prev: TasksSearch) => ({ ...prev, list: id, view: undefined }),
      });
    },
    [navigate],
  );
  const onSelectView = useCallback(
    (view: TaskView) => {
      void navigate({
        to: "/tasks",
        search: (prev: TasksSearch) => ({ ...prev, view, list: undefined }),
      });
    },
    [navigate],
  );
  const onBack = useCallback(() => {
    void navigate({
      to: "/tasks",
      search: (prev: TasksSearch) => ({ ...prev, list: undefined, view: undefined }),
    });
  }, [navigate]);
  const onOpenRecentlyDeleted = useCallback(() => {
    void navigate({ to: "/tasks/recently-deleted" });
  }, [navigate]);
  // "See all results" (#262) own exit: clears `?q=` alone, `onBack`'s own
  // "don't clobber a sibling search param" shape — `list`/`view` survive
  // untouched.
  const onClearQuery = useCallback(() => {
    void navigate({ to: "/tasks", search: (prev: TasksSearch) => ({ ...prev, q: undefined }) });
  }, [navigate]);
  const onOpenTask = useCallback(
    (taskId: string) => {
      void navigate({ to: "/tasks/$taskId", params: { taskId } });
    },
    [navigate],
  );
  return (
    <TasksApp
      selectedTaskListId={search.list ?? null}
      onSelectTaskList={onSelectTaskList}
      selectedView={asTaskView(search.view)}
      onSelectView={onSelectView}
      onBack={onBack}
      onOpenRecentlyDeleted={onOpenRecentlyDeleted}
      query={search.q ?? null}
      onClearQuery={onClearQuery}
      onOpenTask={onOpenTask}
    />
  );
}

/**
 * `/tasks/:taskId` (#253) — a permalink to one open Task, distinct from
 * `?list=`'s view snapshot: it lands on that Task's own List (`task.taskListId`,
 * not a `?list=` of its own — this route's whole point is to work from
 * nothing but the Task's id) with that row expanded and scrolled to.
 * `tasksTaskRoute`'s own `beforeLoad` (`routes.tsx`) already redirected here
 * if the id resolves to nothing, the same guard `notesNoteRoute` gives
 * `/notes/$noteId`, so `task` below is only ever briefly `undefined` — the
 * instant between this route matching and the same already-warm Local Cache
 * read resolving.
 */
export function TasksTaskRoute() {
  const { taskId } = tasksTaskRoute.useParams();
  const navigate = tasksTaskRoute.useNavigate();
  const task = useTask(taskId);
  const onSelectTaskList = useCallback(
    (id: string) => {
      void navigate({ to: "/tasks", search: { list: id } });
    },
    [navigate],
  );
  const onSelectView = useCallback(
    (view: TaskView) => {
      void navigate({ to: "/tasks", search: { view } });
    },
    [navigate],
  );
  const onBack = useCallback(() => {
    void navigate({ to: "/tasks" });
  }, [navigate]);
  const onOpenRecentlyDeleted = useCallback(() => {
    void navigate({ to: "/tasks/recently-deleted" });
  }, [navigate]);
  if (!task) return null;
  return (
    <TasksApp
      selectedTaskListId={task.taskListId}
      onSelectTaskList={onSelectTaskList}
      selectedView={null}
      onSelectView={onSelectView}
      onBack={onBack}
      onOpenRecentlyDeleted={onOpenRecentlyDeleted}
      initialExpandedTaskId={taskId}
    />
  );
}
