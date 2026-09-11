import type { TaskList } from "@mail/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  createTaskList,
  deleteTaskList,
  newTaskListId,
  renameTaskList,
  restoreTaskList,
} from "../store/index.js";
import { TASK_VIEWS, type TaskView } from "./task-view.js";
import { useFocusOnMount } from "./use-focus-on-mount.js";

/**
 * The Task List rail (#252): every live Task List the User holds, in their
 * own manual order (`useTaskLists`'s own doc comment), plus creating,
 * renaming and deleting one (#257) — "Creating and renaming a Task List
 * happen from the sidebar" (the ticket's own words), so none of the three
 * controls live in the main column. A Recently Deleted link (#257) sits
 * below the list, `notes/NotesGrid.tsx`'s own toolbar link reused for a
 * different domain.
 *
 * Selection is a plain callback, not a router `Link` — `mail/SplitView.tsx`'s
 * own `onSelect` shape rather than `notes/NoteCard.tsx`'s `Link`: a `Link`
 * needs a real `RouterProvider` in reach even to render, which would make
 * this component's own tests either build a router harness disproportionate
 * to what they're checking or defer everything to the one full-App
 * integration suite (`notes/NoteEditor.test.tsx`'s own doc comment on
 * exactly that trade-off). `router/TasksRoute.tsx` is what turns this and
 * `onOpenRecentlyDeleted` into a real navigation.
 */
export function TasksSidebar({
  taskLists,
  selectedTaskListId,
  onSelectTaskList,
  selectedView = null,
  onSelectView,
  onOpenRecentlyDeleted,
}: {
  taskLists: readonly TaskList[];
  selectedTaskListId: string | null;
  onSelectTaskList: (id: string) => void;
  /** Today/Upcoming (#254) — mutually exclusive with `selectedTaskListId`, `router/TasksRoute.tsx`'s own job to keep it that way. */
  selectedView?: TaskView | null;
  onSelectView: (view: TaskView) => void;
  onOpenRecentlyDeleted: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useFocusOnMount<HTMLInputElement>();
  const createInputRef = useFocusOnMount<HTMLInputElement>();

  function commitCreate() {
    const trimmed = draftName.trim();
    setCreating(false);
    setDraftName("");
    if (trimmed.length === 0) return;
    const id = newTaskListId();
    void createTaskList(id, trimmed);
    onSelectTaskList(id);
  }

  function commitRename(list: TaskList) {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (trimmed.length === 0 || trimmed === list.name) return;
    void renameTaskList(list.id, trimmed);
  }

  /**
   * Delete (#257): takes every one of the List's own live Tasks with it, in
   * one intent — an Optimistic Action with Restore as its real inverse
   * (ADR-0019), `TaskListView.tsx#deleteTaskRow`'s own shape except the
   * captured `taskIds` `deleteTaskList` returns is what the Undo closure
   * hands back to `restoreTaskList`. Never called for the default List — no
   * control renders for it below (the ticket's own "offers no delete
   * control"), `deleteTaskList`'s own server-side rejection stays the real
   * guard.
   */
  function deleteList(list: TaskList) {
    void (async () => {
      const taskIds = await deleteTaskList(list.id);
      announceUndoableAction("taskListDelete", () => void restoreTaskList(list.id, taskIds));
    })();
  }

  return (
    <nav className="tasks-sidebar" aria-label="Task Lists">
      <ul className="tasks-sidebar-list tasks-sidebar-views">
        {TASK_VIEWS.map((view) => (
          <li key={view.id} className="tasks-sidebar-item">
            <button
              type="button"
              className={`tasks-sidebar-link${view.id === selectedView ? " current" : ""}`}
              aria-current={view.id === selectedView ? "page" : undefined}
              onClick={() => onSelectView(view.id)}
            >
              {view.label}
            </button>
          </li>
        ))}
      </ul>
      <ul className="tasks-sidebar-list">
        {taskLists.map((list) => (
          <li key={list.id} className="tasks-sidebar-item">
            {renamingId === list.id ? (
              <input
                type="text"
                className="tasks-sidebar-rename-input"
                value={renameDraft}
                ref={renameInputRef}
                aria-label={`Rename "${list.name}"`}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => commitRename(list)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename(list);
                  }
                  if (event.key === "Escape") setRenamingId(null);
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className={`tasks-sidebar-link${list.id === selectedTaskListId ? " current" : ""}`}
                  aria-current={list.id === selectedTaskListId ? "page" : undefined}
                  onClick={() => onSelectTaskList(list.id)}
                >
                  {list.name}
                </button>
                <button
                  type="button"
                  className="tasks-sidebar-rename-btn"
                  aria-label={`Rename "${list.name}"`}
                  onClick={() => {
                    setRenamingId(list.id);
                    setRenameDraft(list.name);
                  }}
                >
                  <Pencil size={12} />
                </button>
                {/* The default List cannot be deleted at all (#257's own
                    words) — no control renders for it, rather than one that
                    would only ever be rejected server-side. */}
                {list.isDefault ? null : (
                  <button
                    type="button"
                    className="tasks-sidebar-delete-btn"
                    aria-label={`Delete "${list.name}"`}
                    onClick={() => deleteList(list)}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {creating ? (
        <input
          type="text"
          className="tasks-sidebar-create-input"
          placeholder="List name"
          aria-label="New Task List name"
          value={draftName}
          ref={createInputRef}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={commitCreate}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitCreate();
            }
            if (event.key === "Escape") {
              setCreating(false);
              setDraftName("");
            }
          }}
        />
      ) : (
        <button type="button" className="tasks-sidebar-add" onClick={() => setCreating(true)}>
          <Plus size={14} />
          New list
        </button>
      )}
      {/* Recently Deleted (#257): its own screen, not an overlay —
          `TasksRecentlyDeleted.tsx`'s own doc comment, `notes/NotesGrid.tsx`'s
          own toolbar link precedent. */}
      <button type="button" className="tasks-recently-deleted-link" onClick={onOpenRecentlyDeleted}>
        Recently Deleted
      </button>
    </nav>
  );
}
