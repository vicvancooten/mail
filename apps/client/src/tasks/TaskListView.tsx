import type { Task, TaskList, TaskSection } from "@mail/shared";
import { ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { type DragEvent, useEffect, useState } from "react";
import {
  type TaskBoardMode,
  useTaskBoardMode,
  useTaskCompletedOpen,
} from "../mail/device-preferences.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  completeTask,
  createSection,
  createTask,
  deleteSection,
  newTaskId,
  renameSection,
  reorderSections,
  reorderTask,
  restoreSection,
  setTaskSection,
  uncompleteTask,
  useTasks,
} from "../store/index.js";
import { TaskBoardView } from "./TaskBoardView.js";
import { TaskQuickAdd } from "./TaskQuickAdd.js";
import { TaskRow } from "./TaskRow.js";
import { midpointOrder, SECTION_DRAG_TYPE, TASK_DRAG_TYPE } from "./task-drag.js";
import { useFocusOnMount } from "./use-focus-on-mount.js";

/**
 * How long a just-completed row stays in the active group, fading out
 * (`tasks.css#.task-row--completing`) before it actually leaves for the
 * completed expander — "a completed Task animates out of the active rows"
 * (the ticket's own words), rather than vanishing on the same render its
 * checkbox ticked. Matches `index.css`'s own `--dur-leave` (a row or card
 * departing after an action) — the CSS transition and this timer can never
 * drift out of step, since both read the same constant in spirit.
 */
const COMPLETE_ANIMATION_MS = 260;

/**
 * The main column for one Task List (#252): quick add, then every live Task
 * grouped by Section in the User's manual order, then the completed
 * expander. `useTasks` already hands back live + completed sorted by
 * `order` (`store/tasks.ts#readTasks`'s own doc comment) — this only
 * partitions and groups what's already sorted, `NotesGrid.tsx`'s own
 * "filter, don't re-sort" shape.
 *
 * Sections (#255) live entirely in this component: `groupBySection` reads
 * `taskList.sections`, and creating/renaming/reordering/deleting one is a
 * plain patch of that same array (`store/tasks.ts`'s Section functions) —
 * "Section lives on the Task List row, not its own collection" carries all
 * the way up here, the same reasoning that keeps a Note's Label chips out of
 * a collection of their own.
 *
 * `router/TasksRoute.tsx` is the one place that knows this lives at a
 * route — `taskList`, `onBack` and every other callback here are plain
 * props (`onBack` a plain callback rather than a `Link`, `TasksSidebar.tsx`'s
 * own doc comment on why), so this component (like `MailSection`/`NotesGrid`)
 * can be rendered and tested bare.
 *
 * Board mode (#256): the same List's own Sections seen as columns instead of
 * headed groups, a Device Preference (`device-preferences.ts#useTaskBoardMode`)
 * this header's own toggle flips. `TaskBoardView` owns that whole layout —
 * this component only decides which one is on screen, and hands it the same
 * `all`/`expandedTaskId`/`completingIds`/`toggleComplete` this List view
 * already tracks, so a card expands into the identical `TaskEditor` a row
 * does and the checkbox/Undo toast behavior never forks in two.
 */
export function TaskListView({
  taskList,
  onBack,
  initialExpandedTaskId = null,
}: {
  taskList: TaskList;
  /** Phone-only in practice (`tasks.css`'s narrow-viewport rule hides the control at desktop) — pops back to the sidebar's own List-of-Lists screen. */
  onBack: () => void;
  /** `/tasks/:taskId` (#253, `router/TasksRoute.tsx`) — that Task's own row starts expanded and scrolled to, "whatever view the User was last in." Read once, at mount: a later prop change (a second deep link arriving without a remount) does not re-expand, the same "seed, don't re-drive" shape `useState`'s initializer form always takes. */
  initialExpandedTaskId?: string | null;
}) {
  const tasks = useTasks(taskList.id);
  // Board mode and swimlanes (#256): a Device Preference keyed by this
  // List's own id (`device-preferences.ts`'s own doc comment on why a view
  // id, not one global toggle) — a laptop showing this List as a Board and a
  // phone showing the same List flat are both correct, never synced.
  const [mode, setMode] = useTaskBoardMode(taskList.id);
  const [completedOpen, setCompletedOpen] = useTaskCompletedOpen(taskList.id);
  const [completingIds, setCompletingIds] = useState<ReadonlySet<string>>(() => new Set());
  // "Only one row is expanded at a time" (#253's own acceptance line) — one
  // piece of state here rather than a flag per row, `completingIds`' own
  // sibling.
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(initialExpandedTaskId);

  // Section chrome (#255): a brand-new List (and the seeded default) starts
  // with zero Sections, and "a List with only its default Section shows no
  // Section chrome at all" (the ticket's own words) extends that same plain
  // look through the first Section a User creates — the *second* Section is
  // what actually introduces headings, per-heading rename/delete and the
  // row-flow "Add section" tile. Below that threshold, the header's own
  // small "Add section" control (not part of the row flow) is the only way
  // to create one at all — a deliberate routine call, not itself in the
  // ticket's acceptance criteria.
  const sectioned = taskList.sections.length > 1;

  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useFocusOnMount<HTMLInputElement>();
  const [addingSection, setAddingSection] = useState(false);
  const [sectionDraft, setSectionDraft] = useState("");
  const addSectionInputRef = useFocusOnMount<HTMLInputElement>();
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately once-on-mount — see `initialExpandedTaskId`'s own doc comment above.
  useEffect(() => {
    if (!initialExpandedTaskId) return;
    document.getElementById(`task-row-${initialExpandedTaskId}`)?.scrollIntoView({
      block: "center",
    });
  }, []);

  function addTask(title: string) {
    // "creates in that List's first Section, at the top, with no Due" —
    // `firstSectionId` is `null` until the User has actually added a
    // Section, the same either-way-correct shape `#255`'s own prep left
    // this in.
    const firstSectionId = taskList.sections[0]?.id ?? null;
    void createTask(newTaskId(), taskList.id, firstSectionId, title);
  }

  /**
   * Ticking a row's checkbox completes it optimistically and raises the
   * Undo toast in the same breath (`NotesGrid.tsx#deleteNoteCard`'s own
   * shape) — uncompleting just reverses the intent directly, with no toast
   * of its own (an unchecked box is not itself undoable, `#95`'s own list).
   */
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

  function commitAddSection() {
    const trimmed = sectionDraft.trim();
    setAddingSection(false);
    setSectionDraft("");
    if (trimmed.length === 0) return;
    void createSection(taskList.id, trimmed);
  }

  function startRenameSection(sectionId: string, name: string) {
    setRenamingSectionId(sectionId);
    setRenameDraft(name);
  }

  function commitRenameSection(sectionId: string, name: string) {
    const trimmed = renameDraft.trim();
    setRenamingSectionId(null);
    if (trimmed.length === 0 || trimmed === name) return;
    void renameSection(taskList.id, sectionId, trimmed);
  }

  /**
   * Deletes a Section (#255's own acceptance line): "moves its Tasks to the
   * List's first Section, and undo restores the Section with its Tasks" —
   * `store/tasks.ts#deleteSection` already does the move and hands back
   * exactly what `restoreSection` needs, `TasksSidebar.tsx#deleteList`'s own
   * shape one level down.
   */
  function handleDeleteSection(sectionId: string) {
    void (async () => {
      const deleted = await deleteSection(taskList.id, sectionId);
      if (!deleted) return;
      announceUndoableAction("taskSectionDelete", () => void restoreSection(taskList.id, deleted));
    })();
  }

  /** Section reorder (#255): drags a heading over another and drops — `reorderSections` replaces the whole array, the Client already holds it (`store/tasks.ts`'s own doc comment). */
  function handleSectionDrop(targetSectionId: string, event: DragEvent) {
    const draggedSectionId = event.dataTransfer.getData(SECTION_DRAG_TYPE);
    if (!draggedSectionId || draggedSectionId === targetSectionId) return;
    const ids = taskList.sections.map((section) => section.id);
    const withoutDragged = ids.filter((id) => id !== draggedSectionId);
    const targetIndex = withoutDragged.indexOf(targetSectionId);
    withoutDragged.splice(targetIndex, 0, draggedSectionId);
    void reorderSections(taskList.id, withoutDragged);
  }

  const all = tasks ?? [];
  // A task mid-animate-out is still `completed`, but stays in the active
  // groups until its own timer clears it — see `COMPLETE_ANIMATION_MS`.
  const active = all.filter((task) => !task.completed || completingIds.has(task.id));
  const completed = all
    .filter((task) => task.completed && !completingIds.has(task.id))
    .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));
  // A simple List looks simple (`sectioned` above): every active Task in one
  // flat, unheaded group regardless of any stray `sectionId` a Task carries
  // (a List that once had a second Section and lost it back down to one) —
  // `groupBySection` is only reached for real once there is chrome to show.
  const groups: TaskGroup[] = sectioned
    ? groupBySection(active, taskList.sections)
    : [{ key: "flat", heading: null, sectionId: null, tasks: active }];

  /**
   * Reorders/moves a dropped Task row (#255's own "dragging a row reorders
   * it within its Section... dragging a row onto another Section's heading
   * moves it there") — `beforeIndex` is where in `group.tasks` (already
   * excluding the dragged row, since a Task can't drop before itself)
   * the drop landed; `null` means "at the end of this Section." A synced
   * sort key rather than a splice: `order` becomes the midpoint between its
   * new neighbors, `TaskQuickAdd`'s own `Date.now()` and every existing
   * `order` already sitting on the same number line, so this never needs to
   * touch a Task it didn't move.
   */
  function handleTaskDrop(group: TaskGroup, beforeIndex: number | null, event: DragEvent) {
    const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
    if (!taskId) return;
    // `beforeIndex` (when given) is this row's index in `group.tasks` —
    // still counting the dragged Task itself if it's already a member of
    // this same group. `siblings` below drops it, which shifts every index
    // past its own down by one — the same adjustment a plain array splice
    // would need, done here instead since `midpointOrder` never mutates.
    const draggedIndex = group.tasks.findIndex((task) => task.id === taskId);
    const siblings = group.tasks.filter((task) => task.id !== taskId);
    let index = beforeIndex === null ? siblings.length : beforeIndex;
    if (draggedIndex !== -1 && draggedIndex < index) index -= 1;
    const order = midpointOrder(siblings, index);
    const movedTask = active.find((task) => task.id === taskId);
    if (movedTask && movedTask.sectionId !== group.sectionId) {
      void setTaskSection(taskId, group.sectionId);
    }
    void reorderTask(taskId, order);
  }

  return (
    <section className="tasks-main" aria-label={taskList.name}>
      <div className="tasks-main-header">
        <button
          type="button"
          className="tasks-back"
          aria-label="Back to Task Lists"
          onClick={onBack}
        >
          <ChevronLeft size={18} />
        </button>
        <h2 className="tasks-main-title">{taskList.name}</h2>
        {/* List/Board (#256): a Task List's own switch — Today/Upcoming
            never render this control at all (`TasksApp.tsx`'s own branch),
            the ticket's own "Today/Upcoming offer no such switch".
            `settings/ThisDeviceSection.tsx`'s own plain-`<select>` shape for
            every other Device Preference (Appearance, Layout, density), not
            a bespoke segmented control. */}
        <label className="tasks-mode-field">
          <span>View as</span>
          <select
            aria-label="View as"
            value={mode}
            onChange={(event) => setMode(event.target.value as TaskBoardMode)}
          >
            <option value="list">List</option>
            <option value="board">Board</option>
          </select>
        </label>
        {/* Bootstrap (#255): below the "second Section" threshold, this is
            the only way to create one at all — not part of the row flow the
            ticket's own "no add-section affordance in the row flow" rules
            out at that point. Board mode manages Sections from its own
            column headers instead (#256), so this stays List-only. */}
        {mode === "list" && !sectioned ? (
          addingSection ? (
            <input
              type="text"
              className="tasks-add-section-input"
              placeholder="Section name"
              aria-label="New Section name"
              value={sectionDraft}
              ref={addSectionInputRef}
              onChange={(event) => setSectionDraft(event.target.value)}
              onBlur={commitAddSection}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitAddSection();
                }
                if (event.key === "Escape") {
                  setAddingSection(false);
                  setSectionDraft("");
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="tasks-add-section tasks-add-section--header"
              onClick={() => setAddingSection(true)}
            >
              <Plus size={13} />
              Add section
            </button>
          )
        ) : null}
      </div>
      <TaskQuickAdd onAdd={addTask} />
      {/* Board mode (#256): the Sections-as-columns layout replaces the
          grouped list and its own completed expander outright — the fixed
          Done column is where a completed Task lives instead. Same `all`
          (live + completed, unfiltered) `TaskBoardView` partitions itself,
          `useTasks`'s own doc comment on why completed Tasks are never
          windowed out at the query. */}
      {mode === "board" ? (
        <TaskBoardView
          taskList={taskList}
          tasks={all}
          expandedTaskId={expandedTaskId}
          completingIds={completingIds}
          onToggleComplete={toggleComplete}
          onToggleExpand={(taskId) =>
            setExpandedTaskId((current) => (current === taskId ? null : taskId))
          }
          onCollapse={(taskId) =>
            setExpandedTaskId((current) => (current === taskId ? null : current))
          }
        />
      ) : (
        <>
          {/* Below the two-Section threshold, an empty List is genuinely "no
          Tasks yet" — above it, an empty Section is still a Section a User
          may want to rename, reorder or delete, so its chrome renders
          regardless of whether anything's in it yet. */}
          {all.length === 0 && !sectioned ? (
            <p className="tasks-main-empty">No Tasks yet.</p>
          ) : (
            <div className="tasks-groups">
              {groups.map((group) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: a native HTML5 drop zone (#255, "no drag-and-drop dependency") has no ARIA role of its own — every real control here (the row's checkbox/title, the heading's rename/delete buttons) is its own focusable element; the drag is the shortcut, "Move to" (`TaskEditor.tsx`'s List/Section selects) is the keyboard/screen-reader path (the ticket's own "the menu is the real path").
                <div
                  className="tasks-group"
                  key={group.key}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes(TASK_DRAG_TYPE)) event.preventDefault();
                  }}
                  onDrop={(event) => handleTaskDrop(group, null, event)}
                >
                  {group.heading ? (
                    renamingSectionId === group.sectionId ? (
                      <input
                        type="text"
                        className="tasks-group-rename-input"
                        value={renameDraft}
                        ref={renameInputRef}
                        aria-label={`Rename "${group.heading}"`}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() =>
                          commitRenameSection(group.sectionId as string, group.heading as string)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            (event.target as HTMLInputElement).blur();
                          }
                          if (event.key === "Escape") setRenamingSectionId(null);
                        }}
                      />
                    ) : (
                      // biome-ignore lint/a11y/noStaticElementInteractions: the heading itself is the drag handle (#255's own "reordered... from the group heading"); its Rename/Delete buttons right beside it are the real, focusable controls, `VirtualizedThreadList.tsx`'s own precedent for a drag surface layered over independently operable buttons.
                      <div
                        className="tasks-group-heading-row"
                        draggable={group.sectionId !== null}
                        onDragStart={(event) => {
                          if (group.sectionId === null) return;
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(SECTION_DRAG_TYPE, group.sectionId);
                        }}
                        onDragOver={(event) => {
                          if (
                            event.dataTransfer.types.includes(SECTION_DRAG_TYPE) ||
                            event.dataTransfer.types.includes(TASK_DRAG_TYPE)
                          ) {
                            event.preventDefault();
                          }
                        }}
                        onDrop={(event) => {
                          if (group.sectionId === null) return;
                          if (event.dataTransfer.types.includes(SECTION_DRAG_TYPE)) {
                            event.stopPropagation();
                            handleSectionDrop(group.sectionId, event);
                            return;
                          }
                          // A Task dropped straight on the heading — "moves it
                          // there," at the top of the Section.
                          event.stopPropagation();
                          handleTaskDrop(group, 0, event);
                        }}
                      >
                        <h3 className="tasks-group-heading">{group.heading}</h3>
                        {group.sectionId !== null ? (
                          <>
                            <button
                              type="button"
                              className="tasks-group-rename-btn"
                              aria-label={`Rename "${group.heading}"`}
                              onClick={() =>
                                startRenameSection(
                                  group.sectionId as string,
                                  group.heading as string,
                                )
                              }
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              type="button"
                              className="tasks-group-delete-btn"
                              aria-label={`Delete "${group.heading}"`}
                              onClick={() => handleDeleteSection(group.sectionId as string)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        ) : null}
                      </div>
                    )
                  ) : null}
                  <ul className="task-list">
                    {group.tasks.map((task, index) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        completing={completingIds.has(task.id)}
                        expanded={task.id === expandedTaskId}
                        draggable={!task.completed}
                        dragging={task.id === draggedTaskId}
                        onToggleComplete={() => toggleComplete(task)}
                        onToggleExpand={() =>
                          setExpandedTaskId((current) => (current === task.id ? null : task.id))
                        }
                        onCollapse={() =>
                          setExpandedTaskId((current) => (current === task.id ? null : current))
                        }
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
                          setDraggedTaskId(task.id);
                        }}
                        onDragEnd={() => setDraggedTaskId(null)}
                        onDragOver={(event) => {
                          if (event.dataTransfer.types.includes(TASK_DRAG_TYPE))
                            event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.stopPropagation();
                          handleTaskDrop(group, index, event);
                        }}
                      />
                    ))}
                  </ul>
                </div>
              ))}
              {/* "An 'Add section' affordance at the end of the flow" (the
              ticket's own words) — only once Section chrome is already on;
              below that, the header's own control (above) is the sole path. */}
              {sectioned ? (
                addingSection ? (
                  <input
                    type="text"
                    className="tasks-add-section-input"
                    placeholder="Section name"
                    aria-label="New Section name"
                    value={sectionDraft}
                    ref={addSectionInputRef}
                    onChange={(event) => setSectionDraft(event.target.value)}
                    onBlur={commitAddSection}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitAddSection();
                      }
                      if (event.key === "Escape") {
                        setAddingSection(false);
                        setSectionDraft("");
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="tasks-add-section"
                    onClick={() => setAddingSection(true)}
                  >
                    <Plus size={13} />
                    Add section
                  </button>
                )
              ) : null}
            </div>
          )}
          {completed.length > 0 ? (
            <details
              className="tasks-completed-expander"
              open={completedOpen}
              onToggle={(event) => setCompletedOpen(event.currentTarget.open)}
            >
              <summary>{completed.length} completed</summary>
              <ul className="task-list">
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
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

interface TaskGroup {
  key: string;
  heading: string | null;
  /** `null` for the virtual "No section" bucket — never a real Section, so its heading (when `sectioned` renders one at all) offers no rename/delete/drag-reorder of its own. */
  sectionId: string | null;
  tasks: Task[];
}

/**
 * Groups the given (already-active) Tasks by the List's own `sections`
 * array, in that array's order. A Task naming a Section that no longer
 * exists on the List falls into the same trailing "No section" bucket a
 * Task with no Section at all does.
 */
function groupBySection(tasks: readonly Task[], sections: readonly TaskSection[]): TaskGroup[] {
  const knownIds = new Set(sections.map((section) => section.id));
  const groups: TaskGroup[] = sections.map((section) => ({
    key: section.id,
    heading: section.name,
    sectionId: section.id,
    tasks: tasks.filter((task) => task.sectionId === section.id),
  }));
  const unsectioned = tasks.filter(
    (task) => task.sectionId === null || !knownIds.has(task.sectionId),
  );
  if (unsectioned.length > 0) {
    groups.push({ key: "unsectioned", heading: "No section", sectionId: null, tasks: unsectioned });
  }
  return groups;
}
