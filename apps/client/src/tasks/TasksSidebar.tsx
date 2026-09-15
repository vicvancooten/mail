import type { TaskList } from "@mail/shared";
import { MoreHorizontal, Plus } from "lucide-react";
import { useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu.js";
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
 * The Task List rail (#252, R2 restyle #321): "every live Task List the
 * User holds, in their own manual order" — now built from the exact rail
 * idiom `mail/Sidebar.tsx`/`mail.css` already give Mail's folders
 * (`.nav-item`/`.nav-label`, current = `--color-accent-soft` + accent ink,
 * ghost rows at `--radius-row`) rather than a hand-rolled look of its own
 * (`docs/design/polish-pass.md#Tasks`). Top to bottom: Today/Upcoming, a
 * "Lists" label-tier caption, the Task Lists themselves, a ghost "New list"
 * row, and a quiet "Recently Deleted" row — one flat rail, no hairline down
 * its own edge (`tasks.css#.tasks-split-list` drops `border-right`, ground
 * and gap doing the separating instead, R1/R2).
 *
 * Rename and delete used to be always-visible Pencil/Trash2 icon buttons per
 * row (#257) — R2 calls that out by name ("no hairline-bordered buttons
 * anywhere" reads the same way about controls that clutter a row nobody
 * asked to act on yet). Both now live behind one `ContextMenu` per List row:
 * a right-click anywhere on the row, or the hover/focus-revealed `…` button
 * in a reserved 24px gutter at the row's trailing edge
 * (`ThreadRow.tsx#.row-check`'s own reserved-whitespace reveal, never
 * inserted-and-reflowing) — the button opens the identical menu by firing a
 * synthetic `contextmenu` event at the row itself, so keyboard and touch
 * Users who can't right-click reach the same two entries a mouse User does.
 * The default List still offers no Delete (`deleteList`'s own doc comment,
 * unchanged since #257) but does offer Rename — `store/tasks.ts#renameTaskList`
 * has never itself rejected the default List, only `deleteTaskList` does.
 *
 * Selection is a plain callback, not a router `Link` — `mail/SplitView.tsx`'s
 * own `onSelect` shape rather than `notes/NoteCard.tsx`'s `Link`: a `Link`
 * needs a real `RouterProvider` in reach even to render, which would make
 * this component's own tests either build a router harness disproportionate
 * to what they're checking or defer everything to the one full-App
 * integration suite (`notes/NoteEditor.test.tsx`'s own doc comment on
 * exactly that trade-off). `router/TasksRoute.tsx` is what turns this and
 * `onOpenRecentlyDeleted` into a real navigation; `TasksListsSheet.tsx`
 * renders this exact component again for the phone bottom Sheet (#321).
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

  function startRename(list: TaskList) {
    setRenamingId(list.id);
    setRenameDraft(list.name);
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
   * hands back to `restoreTaskList`. Never offered for the default List — no
   * menu entry renders for it (the ticket's own "offers no delete
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
      <ul className="tasks-nav-list tasks-nav-views">
        {TASK_VIEWS.map((view) => (
          <li key={view.id}>
            <button
              type="button"
              className={`tasks-nav-item${view.id === selectedView ? " current" : ""}`}
              aria-current={view.id === selectedView ? "page" : undefined}
              onClick={() => onSelectView(view.id)}
            >
              <span className="tasks-nav-label">{view.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="tasks-nav-section-label">Lists</p>
      <ul className="tasks-nav-list">
        {taskLists.map((list) =>
          renamingId === list.id ? (
            <li key={list.id} className="tasks-nav-row">
              <input
                type="text"
                className="tasks-nav-rename-input"
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
            </li>
          ) : (
            <TaskListRow
              key={list.id}
              list={list}
              current={list.id === selectedTaskListId}
              onSelect={() => onSelectTaskList(list.id)}
              onRename={() => startRename(list)}
              onDelete={() => deleteList(list)}
            />
          ),
        )}
      </ul>
      {creating ? (
        <input
          type="text"
          className="tasks-nav-rename-input tasks-nav-create-input"
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
        <button
          type="button"
          className="tasks-nav-item tasks-nav-add"
          onClick={() => setCreating(true)}
        >
          <Plus size={14} />
          <span className="tasks-nav-label">New list</span>
        </button>
      )}
      {/* Recently Deleted (#257): its own screen, not an overlay —
          `TasksRecentlyDeleted.tsx`'s own doc comment, `notes/NotesGrid.tsx`'s
          own toolbar link precedent. A quiet row at the foot of the rail
          (`docs/design/polish-pass.md#Tasks`), not styled as a live
          destination the way Today/Upcoming/a List are. */}
      <button
        type="button"
        className="tasks-nav-item tasks-nav-recently-deleted"
        onClick={onOpenRecentlyDeleted}
      >
        <span className="tasks-nav-label">Recently Deleted</span>
      </button>
    </nav>
  );
}

/**
 * One Task List row: the selectable `.tasks-nav-item` plus a reserved 24px
 * trailing gutter holding the hover/focus-revealed `…` button — both the
 * row's own right-click and that button open the same `ContextMenu`
 * (Rename, Delete when not the default List). The button reaches it by
 * dispatching a synthetic, bubbling `contextmenu` event at the row wrapper
 * itself (`rowRef`): Radix's `ContextMenuTrigger` already listens for that
 * native event to open and position itself, so a button click and a real
 * right-click end up driving the exact same code path rather than two
 * independent menus that could drift apart.
 */
function TaskListRow({
  list,
  current,
  onSelect,
  onRename,
  onDelete,
}: {
  list: TaskList;
  current: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  function openMenuFromButton(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    rowRef.current?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.bottom,
      }),
    );
  }

  return (
    <li className="tasks-nav-row">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="tasks-nav-row-trigger" ref={rowRef}>
            <button
              type="button"
              className={`tasks-nav-item${current ? " current" : ""}`}
              aria-current={current ? "page" : undefined}
              onClick={onSelect}
            >
              <span className="tasks-nav-label">{list.name}</span>
            </button>
            <span className="tasks-nav-gutter">
              <button
                type="button"
                className="tasks-nav-more"
                aria-label={`More actions for "${list.name}"`}
                onClick={openMenuFromButton}
              >
                <MoreHorizontal size={14} />
              </button>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for "${list.name}"`}>
          <ContextMenuItem onSelect={onRename}>Rename</ContextMenuItem>
          {list.isDefault ? null : (
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              Delete
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
