import { useTaskLists } from "../store/index.js";
import "./tasks.css";
import { TaskListView } from "./TaskListView.js";
import { TasksListsSheet } from "./TasksListsSheet.js";
import { TasksSearchResults } from "./TasksSearchResults.js";
import { TasksSidebar } from "./TasksSidebar.js";
import { TaskTodayView } from "./TaskTodayView.js";
import { TaskUpcomingView } from "./TaskUpcomingView.js";
import type { TaskView } from "./task-view.js";

function noop() {}

/**
 * The Tasks App's real screen (#252, replacing `PlaceholderRoute`; landing
 * and phone shape rebuilt in #321): a sidebar and one main column on
 * desktop — `mail/SplitView.tsx`'s own shape (sidebar = list, main column =
 * pane), reused for a different domain rather than shared code, the same
 * way `notes/notes.css` duplicates rather than imports `mail/mail.css`'s
 * own toolbar rules.
 *
 * `/tasks` with neither `?list=` nor `?view=` now lands on Today rather than
 * the old "Pick a Task List." empty state (`docs/design/polish-pass.md#Tasks`'s
 * own "shows Today on every width") — `view` below defaults to `"today"`
 * whenever neither a List nor an explicit view was ever selected, computed
 * here rather than in `router/TasksRoute.tsx` so every caller (a bare
 * `<TasksApp>` in a test included) gets the same landing with no route of
 * its own in reach.
 *
 * On phone the rail is a bottom Sheet (`TasksListsSheet.tsx`) rather than a
 * second pane the narrow viewport pushes past — `has-selection` no longer
 * toggles which of `.tasks-split-list`/`.tasks-split-pane` shows (`tasks.css`'s
 * own narrow-viewport rule hides the rail outright now), since the Today
 * default above means the main column always has something to show. The
 * Sheet reads the same `taskLists`/`selectedTaskListId`/`selectedView` this
 * component already holds and writes back through the very same callbacks,
 * so picking a row there is indistinguishable from clicking the desktop
 * rail.
 *
 * `router/TasksRoute.tsx` is the one place that knows this lives at a route
 * — `selectedTaskListId`/`onSelectTaskList` are plain props, so this
 * component (like `MailSection`/`NotesGrid`) renders and tests bare.
 */
export function TasksApp({
  selectedTaskListId,
  onSelectTaskList,
  selectedView = null,
  onSelectView,
  onOpenRecentlyDeleted,
  initialExpandedTaskId = null,
  query = null,
  onClearQuery = noop,
  onOpenTask = noop,
}: {
  selectedTaskListId: string | null;
  /** Fires on a sidebar row click, and once more right after the sidebar's own create flow mints a new List. */
  onSelectTaskList: (id: string) => void;
  /** Today/Upcoming (#254) — mutually exclusive with `selectedTaskListId`, `router/TasksRoute.tsx`'s own job. `null` (with `selectedTaskListId` also `null`) resolves to Today below, never a "nothing selected" empty state. */
  selectedView?: TaskView | null;
  onSelectView: (view: TaskView) => void;
  /** Recently Deleted's own link (#257) — `TasksSidebar.tsx`'s own control, a plain callback for the same reason `onSelectTaskList` is. */
  onOpenRecentlyDeleted: () => void;
  /** `/tasks/:taskId` (#253, `router/TasksRoute.tsx`'s own `TasksTaskRoute`) — forwarded straight to `TaskListView`, which owns what "expanded and scrolled to" actually means. Never reaches Today/Upcoming: that route always resolves to the Task's own List (`TasksTaskRoute`'s own doc comment). */
  initialExpandedTaskId?: string | null;
  /**
   * The Command Palette's own committed query (#262, `?q=`) — set, this
   * replaces the main column with `TasksSearchResults` regardless of
   * `selectedTaskListId`: "See all results" narrows the whole Tasks App, not
   * one List. `null` for every caller that never passes it (this App's own
   * tests included), the same no-search-field-of-its-own posture the ticket
   * asks of the grid.
   */
  query?: string | null;
  /** Clears `?q=` — `TasksSearchResults`' own chip-remove control. */
  onClearQuery?: () => void;
  /** Opens one matching Task from `TasksSearchResults`, `/tasks/:taskId`'s own "expanded on its List" (same route a Palette hit opens). */
  onOpenTask?: (taskId: string) => void;
}) {
  const taskLists = useTaskLists();
  const selected = (taskLists ?? []).find((list) => list.id === selectedTaskListId) ?? null;
  // Today is the landing default (#321): unset unless a List or an explicit
  // view was actually picked — `selected` always wins when both somehow
  // carry a value, `TasksSidebar.tsx`'s own "mutually exclusive" contract.
  const view: TaskView | null = selected ? null : (selectedView ?? "today");

  return (
    <section className="tasks-split-view" aria-label="Tasks">
      <div className="tasks-split-list">
        <TasksSidebar
          taskLists={taskLists ?? []}
          selectedTaskListId={selectedTaskListId}
          onSelectTaskList={onSelectTaskList}
          selectedView={view}
          onSelectView={onSelectView}
          onOpenRecentlyDeleted={onOpenRecentlyDeleted}
        />
      </div>
      <div className="tasks-split-pane">
        {query ? (
          <TasksSearchResults query={query} onClearQuery={onClearQuery} onOpenTask={onOpenTask} />
        ) : view === "upcoming" ? (
          <TaskUpcomingView />
        ) : selected ? (
          <TaskListView taskList={selected} initialExpandedTaskId={initialExpandedTaskId} />
        ) : (
          <TaskTodayView />
        )}
      </div>
      <TasksListsSheet
        taskLists={taskLists ?? []}
        selectedTaskListId={selectedTaskListId}
        onSelectTaskList={onSelectTaskList}
        selectedView={view}
        onSelectView={onSelectView}
        onOpenRecentlyDeleted={onOpenRecentlyDeleted}
      />
    </section>
  );
}
