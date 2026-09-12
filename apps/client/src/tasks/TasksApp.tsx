import { useTaskLists } from "../store/index.js";
import "./tasks.css";
import { TaskListView } from "./TaskListView.js";
import { TasksSearchResults } from "./TasksSearchResults.js";
import { TasksSidebar } from "./TasksSidebar.js";
import { TaskTodayView } from "./TaskTodayView.js";
import { TaskUpcomingView } from "./TaskUpcomingView.js";
import type { TaskView } from "./task-view.js";

function noop() {}

/**
 * The Tasks App's real screen (#252, replacing `PlaceholderRoute`): "a
 * sidebar and one main column: no third pane, no read mode" — `mail/SplitView.tsx`'s
 * own shape (sidebar = list, main column = pane), reused for a different
 * domain rather than shared code, the same way `notes/notes.css` duplicates
 * rather than imports `mail/mail.css`'s own toolbar rules.
 *
 * `has-selection` (`tasks.css`, `SplitView.tsx`'s own doc comment verbatim)
 * is what the narrow-viewport breakpoint reads to show the sidebar full
 * screen with no List picked, or the main column full screen with a List
 * picked and a back control — "Phone: the sidebar is the first screen,
 * tapping a List pushes its Tasks, back returns" (the ticket's own words).
 * At desktop widths both panes show at once regardless of selection.
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
  onBack,
  onOpenRecentlyDeleted,
  initialExpandedTaskId = null,
  query = null,
  onClearQuery = noop,
  onOpenTask = noop,
}: {
  selectedTaskListId: string | null;
  /** Fires on a sidebar row click, and once more right after the sidebar's own create flow mints a new List. */
  onSelectTaskList: (id: string) => void;
  /** Today/Upcoming (#254) — mutually exclusive with `selectedTaskListId`, `router/TasksRoute.tsx`'s own job. */
  selectedView?: TaskView | null;
  onSelectView: (view: TaskView) => void;
  /** The main column's own phone-only back control (`tasks.css`'s narrow-viewport rule hides it at desktop) — pops back to no List selected. */
  onBack: () => void;
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
  const showingMain = Boolean(query) || selected !== null || selectedView !== null;

  return (
    <section
      className={`tasks-split-view${showingMain ? " has-selection" : ""}`}
      aria-label="Tasks"
    >
      <div className="tasks-split-list">
        <TasksSidebar
          taskLists={taskLists ?? []}
          selectedTaskListId={selectedTaskListId}
          onSelectTaskList={onSelectTaskList}
          selectedView={selectedView}
          onSelectView={onSelectView}
          onOpenRecentlyDeleted={onOpenRecentlyDeleted}
        />
      </div>
      <div className="tasks-split-pane">
        {query ? (
          <TasksSearchResults query={query} onClearQuery={onClearQuery} onOpenTask={onOpenTask} />
        ) : selectedView === "today" ? (
          <TaskTodayView onBack={onBack} />
        ) : selectedView === "upcoming" ? (
          <TaskUpcomingView onBack={onBack} />
        ) : selected ? (
          <TaskListView
            taskList={selected}
            onBack={onBack}
            initialExpandedTaskId={initialExpandedTaskId}
          />
        ) : (
          <div className="tasks-main-empty">
            <p>Pick a Task List.</p>
          </div>
        )}
      </div>
    </section>
  );
}
