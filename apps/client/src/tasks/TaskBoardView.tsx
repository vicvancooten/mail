import type { Task, TaskList } from "@mail/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type DragEvent, useState } from "react";
import { type TaskSwimlane, useTaskSwimlane } from "../mail/device-preferences.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  createSection,
  deleteSection,
  renameSection,
  reorderSections,
  reorderTask,
  restoreSection,
  setTaskSection,
  useLabels,
} from "../store/index.js";
import { TaskRow } from "./TaskRow.js";
import {
  type BoardColumn,
  buildBoardColumns,
  buildSwimlaneRows,
  tasksForColumn,
} from "./task-board.js";
import { midpointOrder, SECTION_DRAG_TYPE, TASK_DRAG_TYPE } from "./task-drag.js";
import { useFocusOnMount } from "./use-focus-on-mount.js";

/**
 * A Task List seen as a Board (#256): its Sections as columns, in order,
 * plus a fixed Done column last — cut into swimlane rows by
 * `taskList/device-preferences.ts#useTaskSwimlane`'s own three shapes.
 * "The same intents the list view fires... the Board adds no write path of
 * its own" (the ticket's own words): every drag here ends in exactly the
 * same `setTaskSection`/`reorderTask`/`onToggleComplete` calls
 * `TaskListView.tsx`'s row drag already makes, over `task-drag.ts`'s shared
 * `midpointOrder` and MIME constants.
 *
 * Cards are `TaskRow` unchanged — a card *is* a row, just laid out in a
 * column instead of a stack, and "opening a Task means expanding it in
 * place" (#253) needs no second shape here: `expandedTaskId`/`completingIds`/
 * `onToggleComplete` are `TaskListView.tsx`'s own state, handed down so a
 * card's expanded `TaskEditor` (Section select, Due/Labels popovers, the
 * completion checkbox) is the exact same "menu" the ticket asks every Board
 * move to also be reachable from.
 *
 * Column headers own Section rename/delete/reorder-by-drag and "Add
 * section" (#256's own acceptance line) — the Done and "No section" columns
 * are never real Sections, so neither offers any of that.
 */
export function TaskBoardView({
  taskList,
  tasks,
  expandedTaskId,
  completingIds,
  onToggleComplete,
  onToggleExpand,
  onCollapse,
}: {
  taskList: TaskList;
  /** Live + completed, unfiltered — `TaskListView.tsx`'s own `all`, since the Done column is this view's own home for completed Tasks. */
  tasks: Task[];
  expandedTaskId: string | null;
  completingIds: ReadonlySet<string>;
  /** `TaskListView.tsx#toggleComplete` verbatim — completing raises the Undo toast, uncompleting doesn't, `#95`'s own list. */
  onToggleComplete: (task: Task) => void;
  onToggleExpand: (taskId: string) => void;
  onCollapse: (taskId: string) => void;
}) {
  const labels = useLabels();
  const [swimlane, setSwimlane] = useTaskSwimlane(taskList.id);
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useFocusOnMount<HTMLInputElement>();
  const [addingSection, setAddingSection] = useState(false);
  const [sectionDraft, setSectionDraft] = useState("");
  const addSectionInputRef = useFocusOnMount<HTMLInputElement>();
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);

  const knownSectionIds = new Set(taskList.sections.map((section) => section.id));
  const columns = buildBoardColumns(taskList, tasks);
  const rows = buildSwimlaneRows(swimlane, tasks, labels ?? []);
  // The "Add section" affordance sits between the named Section columns and
  // the fixed "No section"/Done columns — `TaskListView.tsx`'s own "at the
  // end of the flow" placement, one level over. Both the header row and
  // every swimlane row below iterate this exact same three-part split, so
  // their columns can never drift out of alignment with each other.
  const namedColumns = columns.filter((column) => column.sectionId !== null);
  const fixedColumns = columns.filter((column) => column.sectionId === null);

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

  /** `TaskListView.tsx#handleDeleteSection` verbatim. */
  function handleDeleteSection(sectionId: string) {
    void (async () => {
      const deleted = await deleteSection(taskList.id, sectionId);
      if (!deleted) return;
      announceUndoableAction("taskSectionDelete", () => void restoreSection(taskList.id, deleted));
    })();
  }

  /** `TaskListView.tsx#handleSectionDrop` verbatim — a column header dragged onto another reorders the List's Sections. */
  function handleSectionHeaderDrop(targetSectionId: string, event: DragEvent) {
    const draggedSectionId = event.dataTransfer.getData(SECTION_DRAG_TYPE);
    if (!draggedSectionId || draggedSectionId === targetSectionId) return;
    const ids = taskList.sections.map((section) => section.id);
    const withoutDragged = ids.filter((id) => id !== draggedSectionId);
    const targetIndex = withoutDragged.indexOf(targetSectionId);
    withoutDragged.splice(targetIndex, 0, draggedSectionId);
    void reorderSections(taskList.id, withoutDragged);
  }

  /**
   * A card dropped on a column (#256's own three drag outcomes): onto Done,
   * it completes (off Done, it uncompletes) — `column.isDone`/`task.completed`
   * disagreeing is the only signal needed, `onToggleComplete` already knows
   * which direction to fire and whether that raises the Undo toast; onto any
   * other column, its Section changes to match (a no-op patch when it
   * already did) and it reorders to `beforeIndex` among `cellTasks`
   * (`null` = the end) via the same synced-midpoint `order` List mode uses.
   * Reordering *within* Done is a no-op beyond completing it again: Done
   * sorts by `completedAt`, not manual order, so there is nothing here for a
   * drop index to mean.
   */
  function handleCardDrop(
    column: BoardColumn,
    cellTasks: readonly Task[],
    beforeIndex: number | null,
    event: DragEvent,
  ) {
    const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
    if (!taskId) return;
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;

    if (column.isDone) {
      if (!task.completed) onToggleComplete(task);
      return;
    }
    if (task.completed) onToggleComplete(task);
    if (task.sectionId !== column.sectionId) void setTaskSection(taskId, column.sectionId);

    const draggedIndex = cellTasks.findIndex((candidate) => candidate.id === taskId);
    const siblings = cellTasks.filter((candidate) => candidate.id !== taskId);
    let index = beforeIndex === null ? siblings.length : beforeIndex;
    if (draggedIndex !== -1 && draggedIndex < index) index -= 1;
    void reorderTask(taskId, midpointOrder(siblings, index));
  }

  function renderColumnHeader(column: BoardColumn) {
    if (column.sectionId === null) {
      return <h3 className="task-board-column-name">{column.name}</h3>;
    }
    const sectionId = column.sectionId;
    if (renamingSectionId === sectionId) {
      return (
        <input
          type="text"
          className="tasks-group-rename-input"
          value={renameDraft}
          ref={renameInputRef}
          aria-label={`Rename "${column.name}"`}
          onChange={(event) => setRenameDraft(event.target.value)}
          onBlur={() => commitRenameSection(sectionId, column.name)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "Escape") setRenamingSectionId(null);
          }}
        />
      );
    }
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: the header itself is the drag handle for reordering Sections (`TaskListView.tsx#.tasks-group-heading-row`'s own precedent) and the drop target a card lands on to move to the top of this column — its Rename/Delete buttons right beside it are the real, focusable controls.
      <div
        className="task-board-column-header"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(SECTION_DRAG_TYPE, sectionId);
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
          if (event.dataTransfer.types.includes(SECTION_DRAG_TYPE)) {
            event.stopPropagation();
            handleSectionHeaderDrop(sectionId, event);
            return;
          }
          // A card dropped straight on the header — to the top of this
          // column, across every swimlane row (`tasks` is the whole List's
          // own Tasks, not one row's slice of it).
          event.stopPropagation();
          handleCardDrop(column, tasksForColumn(tasks, column, knownSectionIds), 0, event);
        }}
      >
        <h3 className="task-board-column-name">{column.name}</h3>
        <button
          type="button"
          className="tasks-group-rename-btn"
          aria-label={`Rename "${column.name}"`}
          onClick={() => startRenameSection(sectionId, column.name)}
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          className="tasks-group-delete-btn"
          aria-label={`Delete "${column.name}"`}
          onClick={() => handleDeleteSection(sectionId)}
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  }

  function renderAddSectionHeader() {
    if (addingSection) {
      return (
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
      );
    }
    return (
      <button type="button" className="tasks-add-section" onClick={() => setAddingSection(true)}>
        <Plus size={13} />
        Add section
      </button>
    );
  }

  function renderColumnBody(column: BoardColumn, cellTasks: Task[]) {
    return (
      // A `<section>` (not a `<div>`) precisely so `aria-label` is valid here
      // without a bolted-on `role` — `.tasks-main`'s own labelled-`<section>`
      // shape, one level down, and what gives each column body a real
      // accessible name (`TaskListView.test.tsx`'s own drop-target queries).
      <section
        className="task-board-column-body"
        aria-label={`${column.name} column`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(TASK_DRAG_TYPE)) event.preventDefault();
        }}
        onDrop={(event) => handleCardDrop(column, cellTasks, null, event)}
      >
        <ul className="task-list task-board-cards">
          {cellTasks.map((task, index) => (
            <TaskRow
              key={task.id}
              task={task}
              completing={completingIds.has(task.id)}
              expanded={task.id === expandedTaskId}
              draggable={!column.isDone}
              dragging={task.id === draggedTaskId}
              onToggleComplete={() => onToggleComplete(task)}
              onToggleExpand={() => onToggleExpand(task.id)}
              onCollapse={() => onCollapse(task.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
                setDraggedTaskId(task.id);
              }}
              onDragEnd={() => setDraggedTaskId(null)}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes(TASK_DRAG_TYPE)) event.preventDefault();
              }}
              onDrop={(event) => {
                event.stopPropagation();
                handleCardDrop(column, cellTasks, index, event);
              }}
            />
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className="task-board" aria-label="Board">
      <div className="task-board-toolbar">
        <label className="task-board-swimlane-field">
          <span>Group by</span>
          <select
            aria-label="Group Board rows by"
            value={swimlane}
            onChange={(event) => setSwimlane(event.target.value as TaskSwimlane)}
          >
            <option value="none">None</option>
            <option value="label">Label</option>
            <option value="dueBucket">Due date</option>
          </select>
        </label>
      </div>
      <div className="task-board-columns-header">
        {namedColumns.map((column) => (
          <div className="task-board-column-slot" key={column.id}>
            {renderColumnHeader(column)}
          </div>
        ))}
        <div className="task-board-column-slot">{renderAddSectionHeader()}</div>
        {fixedColumns.map((column) => (
          <div className="task-board-column-slot" key={column.id}>
            {renderColumnHeader(column)}
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <div className="task-board-row" key={row.key}>
          {row.heading ? <h3 className="task-board-row-heading">{row.heading}</h3> : null}
          <div className="task-board-row-columns">
            {namedColumns.map((column) => (
              <div className="task-board-column-slot" key={column.id}>
                {renderColumnBody(column, tasksForColumn(row.tasks, column, knownSectionIds))}
              </div>
            ))}
            <div className="task-board-column-slot" />
            {fixedColumns.map((column) => (
              <div className="task-board-column-slot" key={column.id}>
                {renderColumnBody(column, tasksForColumn(row.tasks, column, knownSectionIds))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
