import type {
  DocumentSave,
  DocumentSaveOutcome,
  NoteDocument,
  Task,
  TaskList,
  TaskSection,
  TaskThreadLink,
} from "@mail/shared";
import { EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { localDateInputValue, wireDueDateToDateInputValue } from "../tasks/task-due.js";
import type { PendingTaskSave } from "./db.js";
import { localCache } from "./local-cache.js";
import { labelIdForName, sessionUserId } from "./session.js";
import { generateUlid } from "./ulid.js";
import { enqueueUserMutation } from "./user-mutation-queue.js";

/**
 * `TaskList`/`Task` (#251, epic #249, ADR-0030) — the Local Cache's own read
 * and write surface, `notes.ts`'s own shape: structural actions ride the
 * User-scoped Optimistic Action queue (`user-mutation-queue.ts`) with real
 * inverses (ADR-0019); a Task's body edits ride `pendingTaskSaves` instead,
 * last-write-wins, never rejected.
 *
 * This ticket wires the wire/cache plumbing only — "nothing rendering them
 * yet" — so the surface below is deliberately the minimum a later App
 * ticket (the grid, the Board, mail-to-task) can build on without a reshape:
 * one hook and one read function per natural query, one write function per
 * intent, no component-facing convenience beyond that.
 */

/** A fresh Task List id — `notes.ts#newNoteId`'s own "address exists before the round trip" shape. */
export function newTaskListId(): string {
  return generateUlid();
}

/** A fresh Task id, same shape. */
export function newTaskId(): string {
  return generateUlid();
}

/** A fresh Section id — Sections aren't their own collection (`tasks.ts#taskListSchema`'s own doc comment), but still Client-minted ULIDs, the same offline-derivable reasoning. */
export function newSectionId(): string {
  return generateUlid();
}

// ---------------------------------------------------------------------------
// Task List
// ---------------------------------------------------------------------------

export function useTaskLists(): TaskList[] | undefined {
  return useLiveQuery(() => readTaskLists(), []);
}

/** Every Task List this User holds, minus soft-deleted ones, ordered the way the User last arranged them. */
export async function readTaskLists(): Promise<TaskList[]> {
  const rows = await localCache().taskLists.toArray();
  return rows
    .filter((row) => row.deletedAt === null)
    .sort((left, right) => left.order - right.order);
}

export function useTaskList(id: string | null): TaskList | undefined {
  return useLiveQuery(() => readTaskList(id), [id]);
}

export async function readTaskList(id: string | null): Promise<TaskList | undefined> {
  if (id === null) return undefined;
  return localCache().taskLists.get(id);
}

/**
 * Whether `id` names a Task List that's still live — `notes.ts#noteExists`'s
 * own shape. `?list=` (#253, `routes.tsx#TasksSearch`) no longer gates on
 * this itself: an unknown or soft-deleted id there just leaves `TasksApp`
 * with nothing selected, `mailRoute`'s own tolerance for an unrecognized
 * `folder` — this is `taskExists`'s own building block instead (a Task
 * whose List has gone to Recently Deleted resolves the same as one that
 * never existed).
 */
export async function taskListExists(id: string): Promise<boolean> {
  const list = await localCache().taskLists.get(id);
  return list !== undefined && list.deletedAt === null;
}

/**
 * Recently Deleted's own entry shape for a Task List (#257): "one entry for
 * the List — 'Errands (7 tasks)' — Restore brings back the List and every
 * Task it took." `taskIds` is exactly that set, re-derived here (every Task
 * currently under this List that's itself soft-deleted — `deleteTaskList`
 * cascades onto every one of its own live Tasks, so past that call there is
 * nothing under a deleted List left live) rather than the ephemeral set the
 * original `deleteTaskList` call returned, which only the Undo toast's own
 * closure still holds — both are the exact set `restoreTaskList` needs to
 * undo the delete precisely (ADR-0019).
 */
export interface DeletedTaskListEntry {
  list: TaskList;
  taskIds: string[];
}

/**
 * Recently Deleted (#257): every Task List this User has soft-deleted, most
 * recently deleted first — `notes.ts#readDeletedNotes`'s own mirror-image
 * shape, filtering the opposite way `readTaskLists` does over the same
 * `taskLists` table. A purged List (`sync/trash-purge.ts`, 30 days on)
 * simply stops appearing here the next sync round, the same "tombstone
 * removes the row" path any other destroyed entity takes.
 */
export function useDeletedTaskLists(): DeletedTaskListEntry[] | undefined {
  return useLiveQuery(() => readDeletedTaskLists(), []);
}

export async function readDeletedTaskLists(): Promise<DeletedTaskListEntry[]> {
  const db = localCache();
  const lists = (await db.taskLists.toArray())
    .filter((row): row is TaskList & { deletedAt: string } => row.deletedAt !== null)
    .sort((left, right) => (right.deletedAt as string).localeCompare(left.deletedAt as string));

  return Promise.all(
    lists.map(async (list) => {
      const rows = await db.tasks.where("taskListId").equals(list.id).toArray();
      const taskIds = rows.filter((row) => row.deletedAt !== null).map((row) => row.id);
      return { list, taskIds };
    }),
  );
}

/** Creates a Task List (#251): writes the durable row optimistically — no Sections, not the default — and enqueues `createTaskList`, whose real inverse is `deleteTaskList` with an empty `taskIds` (ADR-0019). `id` is minted by the caller (`newTaskListId`). */
export async function createTaskList(id: string, name: string): Promise<void> {
  const userId = sessionUserId();
  if (userId === null) return;
  const now = new Date().toISOString();
  await localCache().taskLists.put({
    id,
    userId,
    name,
    sections: [],
    isDefault: false,
    order: 0,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await enqueueUserMutation({ type: "createTaskList", taskListId: id, name });
}

/** Renames a Task List — an absolute set, self-inverse via the caller's own captured old name (ADR-0019). */
export async function renameTaskList(id: string, name: string): Promise<void> {
  await enqueueUserMutation({ type: "renameTaskList", taskListId: id, name });
  await patchTaskListLocally(id, { name });
}

/** Reorders a Task List among this User's own — same absolute-set shape as `renameTaskList`. */
export async function reorderTaskList(id: string, order: number): Promise<void> {
  await enqueueUserMutation({ type: "reorderTaskList", taskListId: id, order });
  await patchTaskListLocally(id, { order });
}

/**
 * Deletes a Task List (#251): soft, cascading a delete onto every one of its
 * own live Tasks in the same intent — `taskIds` is captured **here**, at
 * decision time, the same "captured, not re-derived server-side" reasoning
 * `sync.ts#mutationIntentSchema`'s `unblockAndRestore` already gives, and is
 * exactly what the caller must hand back to `restoreTaskList` to undo this
 * precisely (ADR-0019). A no-op against the seeded default List — callers
 * should check `TaskList.isDefault` before ever offering this, the same way
 * `deleteTaskList`'s own rejection is a Sync Backend guard, not a Client one.
 */
export async function deleteTaskList(id: string): Promise<string[]> {
  const db = localCache();
  const now = new Date().toISOString();
  const taskIds = await db.transaction("rw", [db.taskLists, db.tasks], async () => {
    const list = await db.taskLists.get(id);
    if (!list || list.deletedAt !== null) return [];
    await db.taskLists.put({ ...list, deletedAt: now, updatedAt: now });

    const rows = await db.tasks.where("taskListId").equals(id).toArray();
    const live = rows.filter((row) => row.deletedAt === null);
    await db.tasks.bulkPut(live.map((row) => ({ ...row, deletedAt: now, updatedAt: now })));
    return live.map((row) => row.id);
  });
  await enqueueUserMutation({ type: "deleteTaskList", taskListId: id, taskIds });
  return taskIds;
}

/** Restores a Task List, the real inverse of `deleteTaskList` — `taskIds` is the exact set that call returned. */
export async function restoreTaskList(id: string, taskIds: string[]): Promise<void> {
  const db = localCache();
  const now = new Date().toISOString();
  await db.transaction("rw", [db.taskLists, db.tasks], async () => {
    const list = await db.taskLists.get(id);
    if (list) await db.taskLists.put({ ...list, deletedAt: null, updatedAt: now });

    const rows = await db.tasks.bulkGet(taskIds);
    const restored = rows.flatMap((row) =>
      row ? [{ ...row, deletedAt: null, updatedAt: now }] : [],
    );
    if (restored.length > 0) await db.tasks.bulkPut(restored);
  });
  await enqueueUserMutation({ type: "restoreTaskList", taskListId: id, taskIds });
}

async function patchTaskListLocally(id: string, patch: Partial<TaskList>): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.taskLists, async () => {
    const row = await db.taskLists.get(id);
    if (!row) return;
    await db.taskLists.put({ ...row, ...patch, updatedAt: new Date().toISOString() });
  });
}

// ---------------------------------------------------------------------------
// Section — lives on the Task List row's own `sections` array (#251)
// ---------------------------------------------------------------------------

/** Creates a Section, appended to the List's ordered array. `id` is minted here (`newSectionId`), the same "address exists before the round trip" a Task List/Task's own id has. */
export async function createSection(taskListId: string, name: string): Promise<string> {
  const id = newSectionId();
  await patchSectionsLocally(taskListId, (sections) => [...sections, { id, name }]);
  await enqueueUserMutation({ type: "createSection", taskListId, sectionId: id, name });
  return id;
}

/** Renames a Section in place — an absolute set, self-inverse via the caller's own captured old name. */
export async function renameSection(
  taskListId: string,
  sectionId: string,
  name: string,
): Promise<void> {
  await patchSectionsLocally(taskListId, (sections) =>
    sections.map((section) => (section.id === sectionId ? { id: sectionId, name } : section)),
  );
  await enqueueUserMutation({ type: "renameSection", taskListId, sectionId, name });
}

/** Reorders every Section of one List to the given order — replaces the whole array, the Client already holds it. */
export async function reorderSections(taskListId: string, sectionIds: string[]): Promise<void> {
  await patchSectionsLocally(taskListId, (sections) => {
    const byId = new Map(sections.map((section) => [section.id, section]));
    const reordered = sectionIds.flatMap((id) => {
      const section = byId.get(id);
      return section ? [section] : [];
    });
    const missing = sections.filter((section) => !sectionIds.includes(section.id));
    return [...reordered, ...missing];
  });
  await enqueueUserMutation({ type: "reorderSections", taskListId, sectionIds });
}

/** One `deleteSection` call's own capture — what `restoreSection` needs to undo it exactly (ADR-0019). */
export interface DeletedSection {
  sectionId: string;
  name: string;
  /** Where in the List's `sections` array it sat, for `restoreSection` to reinsert it at. */
  index: number;
  /** This User's own Tasks the delete moved off the Section — captured here, at decision time, `deleteTaskList`'s own reasoning. */
  taskIds: string[];
}

/**
 * Deletes a Section (#251): removes it from the List's ordered array and
 * moves its own Tasks to the List's first remaining Section (`null` if none
 * is left), in the same intent. Returns the capture `restoreSection` needs
 * to undo this precisely — `null` if the Section was already gone.
 */
export async function deleteSection(
  taskListId: string,
  sectionId: string,
): Promise<DeletedSection | null> {
  const db = localCache();
  const now = new Date().toISOString();
  return db.transaction("rw", [db.taskLists, db.tasks], async () => {
    const list = await db.taskLists.get(taskListId);
    if (!list) return null;
    const index = list.sections.findIndex((section) => section.id === sectionId);
    if (index === -1) return null;
    const removed = list.sections[index] as TaskSection;
    const sections = list.sections.filter((section) => section.id !== sectionId);
    const fallbackSectionId = sections[0]?.id ?? null;
    await db.taskLists.put({ ...list, sections, updatedAt: now });

    const rows = await db.tasks
      .where("taskListId")
      .equals(taskListId)
      .filter((row) => row.sectionId === sectionId && row.deletedAt === null)
      .toArray();
    if (rows.length > 0) {
      await db.tasks.bulkPut(
        rows.map((row) => ({ ...row, sectionId: fallbackSectionId, updatedAt: now })),
      );
    }
    return { sectionId, name: removed.name, index, taskIds: rows.map((row) => row.id) };
  });
}

/** Restores a Section, the real inverse of `deleteSection` — `deleted` is the exact capture that call returned. */
export async function restoreSection(taskListId: string, deleted: DeletedSection): Promise<void> {
  const db = localCache();
  const now = new Date().toISOString();
  await db.transaction("rw", [db.taskLists, db.tasks], async () => {
    const list = await db.taskLists.get(taskListId);
    if (list && !list.sections.some((section) => section.id === deleted.sectionId)) {
      const sections = list.sections.slice();
      const index = Math.min(Math.max(deleted.index, 0), sections.length);
      sections.splice(index, 0, { id: deleted.sectionId, name: deleted.name });
      await db.taskLists.put({ ...list, sections, updatedAt: now });
    }

    const rows = await db.tasks.bulkGet(deleted.taskIds);
    const restored = rows.flatMap((row) =>
      row ? [{ ...row, sectionId: deleted.sectionId, updatedAt: now }] : [],
    );
    if (restored.length > 0) await db.tasks.bulkPut(restored);
  });
  await enqueueUserMutation({
    type: "restoreSection",
    taskListId,
    sectionId: deleted.sectionId,
    name: deleted.name,
    index: deleted.index,
    taskIds: deleted.taskIds,
  });
}

async function patchSectionsLocally(
  taskListId: string,
  update: (sections: TaskSection[]) => TaskSection[],
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.taskLists, async () => {
    const row = await db.taskLists.get(taskListId);
    if (!row) return;
    await db.taskLists.put({
      ...row,
      sections: update(row.sections),
      updatedAt: new Date().toISOString(),
    });
  });
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export function useTasks(taskListId: string | null): Task[] | undefined {
  return useLiveQuery(() => readTasks(taskListId), [taskListId]);
}

/** Every live Task of one List, completed included ("completed Tasks are included in replication and never windowed out" — the same holds for this local read), ordered the way the User last arranged them. */
export async function readTasks(taskListId: string | null): Promise<Task[]> {
  if (taskListId === null) return [];
  const rows = await localCache().tasks.where("taskListId").equals(taskListId).toArray();
  return rows
    .filter((row) => row.deletedAt === null)
    .sort((left, right) => left.order - right.order);
}

/**
 * Sorts already-filtered Tasks the way Today/Upcoming both order their own
 * rows (#254's own acceptance line): by due time first — a bare string
 * compare over `"HH:MM"`/`null`, `task-due.ts`'s own "floating, never a real
 * instant" reasoning, so no-time Tasks (`""` sorts first) group ahead of
 * timed ones — then by this User's own manual order, `readTasks`'s own tie
 * break.
 */
function compareByDueTimeThenOrder(left: Task, right: Task): number {
  const timeCompare = (left.dueTime ?? "").localeCompare(right.dueTime ?? "");
  if (timeCompare !== 0) return timeCompare;
  return left.order - right.order;
}

export function useTodayTasks(): Task[] | undefined {
  return useLiveQuery(() => readTodayTasks(), []);
}

/**
 * Today (#254): every live Task due today or overdue, across every List —
 * "where overdue Tasks gather... not the Calendar grid's" job (the ticket's
 * own words) — sorted by due time then manual order (`compareByDueTimeThenOrder`).
 * A Task with no `dueDate` never appears here (`readTasks`'s own per-List
 * query is still where it shows). Completed Tasks are included, same as
 * `readTasks` — the view's own "N completed" expander is what partitions
 * them back out, not this query. `now` is injectable, `task-due.ts#isOverdue`'s
 * own shape, so a test can pin "today" rather than race the real clock.
 */
export async function readTodayTasks(now: Date = new Date()): Promise<Task[]> {
  const today = localDateInputValue(now);
  const rows = await localCache().tasks.toArray();
  return rows
    .filter(
      (row): row is Task & { dueDate: string } =>
        row.deletedAt === null &&
        row.dueDate !== null &&
        wireDueDateToDateInputValue(row.dueDate) <= today,
    )
    .sort(compareByDueTimeThenOrder);
}

/** One Upcoming day group (#254) — every live Task across every List that shares this `dueDate`. */
export interface UpcomingDayGroup {
  /** The wire-encoded `dueDate` (`task-due.ts#dateOnlyToWireDueDate`) every Task in this group shares — a per-group quick add (`TaskUpcomingView.tsx`) creates straight against this value. */
  dueDate: string;
  tasks: Task[];
}

export function useUpcomingTasks(): UpcomingDayGroup[] | undefined {
  return useLiveQuery(() => readUpcomingTasks(), []);
}

/**
 * Upcoming (#254): every live Task due **after** today, across every List,
 * grouped by day (earliest first) and, within a day, sorted by due time then
 * manual order — `readTodayTasks`'s own sibling on the other side of
 * "today". A Task with no `dueDate` never appears here — "only in its own
 * List, never here" (the ticket's own words). Completed Tasks are included,
 * same reasoning as `readTodayTasks`. `now` is injectable, the same reason
 * `readTodayTasks`'s own parameter is.
 */
export async function readUpcomingTasks(now: Date = new Date()): Promise<UpcomingDayGroup[]> {
  const today = localDateInputValue(now);
  const rows = await localCache().tasks.toArray();
  const upcoming = rows.filter(
    (row): row is Task & { dueDate: string } =>
      row.deletedAt === null &&
      row.dueDate !== null &&
      wireDueDateToDateInputValue(row.dueDate) > today,
  );

  const byDay = new Map<string, Task[]>();
  for (const row of upcoming) {
    const group = byDay.get(row.dueDate);
    if (group) group.push(row);
    else byDay.set(row.dueDate, [row]);
  }

  return [...byDay.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([dueDate, tasks]) => ({ dueDate, tasks: tasks.sort(compareByDueTimeThenOrder) }));
}

export function useTask(id: string | null): Task | undefined {
  return useLiveQuery(() => readTask(id), [id]);
}

export async function readTask(id: string | null): Promise<Task | undefined> {
  if (id === null) return undefined;
  return localCache().tasks.get(id);
}

/**
 * Every live Task across every live List (#262): the Command Palette's own
 * local-hit read (a hit can come from any List, not the one currently
 * selected) and the Tasks App's own "See all results" aggregate view —
 * `readDeletedTasks`'s own "exclude a Task whose List is also deleted"
 * shape, run over the opposite (live) partition.
 */
export function useAllTasks(): Task[] | undefined {
  return useLiveQuery(() => readAllTasks(), []);
}

export async function readAllTasks(): Promise<Task[]> {
  const db = localCache();
  const rows = await db.tasks.toArray();
  const live = rows.filter((row) => row.deletedAt === null);

  const listIds = new Set(live.map((row) => row.taskListId));
  const lists = await db.taskLists.bulkGet([...listIds]);
  const liveListIds = new Set(
    lists.flatMap((list) => (list && list.deletedAt === null ? [list.id] : [])),
  );

  return live.filter((row) => liveListIds.has(row.taskListId));
}

export function useOpenTasksForThread(threadId: string): Task[] | undefined {
  return useLiveQuery(() => readOpenTasksForThread(threadId), [threadId]);
}

/**
 * The Reader's own chip row (#259): every open Task whose Thread Link
 * **field** — never a Thread Link block sitting in the body, `taskSchema`'s
 * own "only the field drives chips" — names `threadId`, `readAllTasks`'s
 * own live-Task-on-a-live-List filter narrowed one step further to
 * `threadLink`. A Local Cache query over the whole-replicated `Task`
 * collection: no request, no search index, no server-side join — "the
 * concrete payoff of replicating Tasks whole" (the ticket's own words).
 * Completed Tasks are excluded here, unlike `readAllTasks`/`readTasks`:
 * this is the one Task read in the app where "completed Tasks are
 * included in replication and never windowed out" doesn't apply, because
 * the ticket's own acceptance line is "Completed Tasks do not appear."
 */
export async function readOpenTasksForThread(threadId: string): Promise<Task[]> {
  const all = await readAllTasks();
  return all.filter((task) => !task.completed && task.threadLink?.threadId === threadId);
}

/**
 * Whether `id` names a Task that's still live **and** whose own List is
 * still live (#253) — `taskListExists`'s own shape, for `routes.tsx`'s
 * `/tasks/:taskId` deep-link guard: a Task inside a soft-deleted List
 * (`#257`'s own "resolves to `/tasks`, like any other unresolvable id")
 * redirects the same way a Task that never existed does.
 */
export async function taskExists(id: string): Promise<boolean> {
  const db = localCache();
  const task = await db.tasks.get(id);
  if (!task || task.deletedAt !== null) return false;
  const list = await db.taskLists.get(task.taskListId);
  return list !== undefined && list.deletedAt === null;
}

/**
 * Recently Deleted (#257): every Task this User has soft-deleted on its
 * own, most recently deleted first — `notes.ts#readDeletedNotes`'s own
 * mirror-image shape. Excludes a Task whose own List is *also* deleted
 * (the ticket's own "A Task inside a deleted List is not listed separately
 * in Recently Deleted" — it surfaces instead as part of that List's single
 * `readDeletedTaskLists` entry). A purged Task (`sync/trash-purge.ts`, 30
 * days on) simply stops appearing here the next sync round.
 */
export function useDeletedTasks(): Task[] | undefined {
  return useLiveQuery(() => readDeletedTasks(), []);
}

export async function readDeletedTasks(): Promise<Task[]> {
  const db = localCache();
  const rows = await db.tasks.toArray();
  const deleted = rows.filter((row): row is Task & { deletedAt: string } => row.deletedAt !== null);

  const listIds = new Set(deleted.map((row) => row.taskListId));
  const lists = await db.taskLists.bulkGet([...listIds]);
  const liveListIds = new Set(
    lists.flatMap((list) => (list && list.deletedAt === null ? [list.id] : [])),
  );

  return deleted
    .filter((row) => liveListIds.has(row.taskListId))
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

/** Creates a Task (#251): writes the durable row optimistically — empty body, incomplete — and enqueues `createTask`, whose real inverse is the **hard** `deleteTask` (ADR-0019, `notes.ts#createNote`'s own shape). `id` is minted by the caller (`newTaskId`). `threadLink` (#258) is the Thread Link field, set once here and never patched afterward — `null` for every ordinary caller. */
export async function createTask(
  id: string,
  taskListId: string,
  sectionId: string | null,
  title: string,
  order: number = Date.now(),
  threadLink: TaskThreadLink | null = null,
): Promise<void> {
  const userId = sessionUserId();
  if (userId === null) return;
  const now = new Date().toISOString();
  await localCache().tasks.put({
    id,
    userId,
    taskListId,
    sectionId,
    title,
    document: EMPTY_NOTE_DOCUMENT,
    completed: false,
    completedAt: null,
    dueDate: null,
    dueTime: null,
    labelIds: [],
    threadLink,
    order,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await enqueueUserMutation({
    type: "createTask",
    taskId: id,
    taskListId,
    sectionId,
    title,
    order,
    threadLink,
  });
}

/**
 * "Add to Tasks" (#258): a Task created *around* a Thread Link snapshot —
 * the field (`taskSchema#threadLink`), not the body. Unlike
 * `notes.ts#createNoteFromThreadLink`, this never writes a body at all: no
 * paragraph, no Thread Link block — "the mail itself is never copied into
 * the Task" (the ticket's own words) covers the title too, which already
 * lives in `title` alone. A User can still insert the same block into the
 * body by hand later, through the ordinary slash menu
 * (`notes/note-slash-menu-items.tsx`) `TaskEditor.tsx`'s `NoteEditor` already
 * wires up unchanged — this call just never does that itself.
 *
 * `dueDate`, when given, commits right after creation through the ordinary
 * `setTaskDueDate` absolute-set intent — its own call, not threaded through
 * `createTask`'s payload, the same "patch its fields per field" posture
 * every other Due write already takes.
 */
export async function createTaskFromThreadLink(
  taskListId: string,
  title: string,
  threadLink: TaskThreadLink,
  dueDate: string | null = null,
): Promise<string> {
  const id = newTaskId();
  await createTask(id, taskListId, null, title, undefined, threadLink);
  if (dueDate) await setTaskDueDate(id, dueDate);
  return id;
}

/** Deletes a Task (#251): permanent, the real inverse of `createTask` — `notes.ts#deleteNote`'s own shape, not the soft `trashTask`/`restoreTask` pair below. */
export async function deleteTask(id: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.tasks, db.pendingTaskSaves], async () => {
    await db.tasks.delete(id);
    await db.pendingTaskSaves.delete(id);
  });
  await enqueueUserMutation({ type: "deleteTask", taskId: id });
}

/** Patches a Task's title — "patch its fields per field", an absolute set. */
export async function setTaskTitle(id: string, title: string): Promise<void> {
  await enqueueUserMutation({ type: "setTaskTitle", taskId: id, title });
  await patchTaskLocally(id, { title });
}

/** Patches a Task's due date — the other patchable field, nullable. */
export async function setTaskDueDate(id: string, dueDate: string | null): Promise<void> {
  await enqueueUserMutation({ type: "setTaskDueDate", taskId: id, dueDate });
  await patchTaskLocally(id, { dueDate });
}

/**
 * Patches a Task's floating due time (#253) — its own absolute-set intent,
 * `setTaskDueDate`'s sibling. Never set without a `dueDate`
 * (`tasks.ts#taskSchema`'s own doc comment): that invariant is the Due
 * picker's own job (`TaskDuePicker.tsx` clears both fields in the same
 * breath when the User picks "No date"), not this setter's.
 */
export async function setTaskDueTime(id: string, dueTime: string | null): Promise<void> {
  await enqueueUserMutation({ type: "setTaskDueTime", taskId: id, dueTime });
  await patchTaskLocally(id, { dueTime });
}

/** Completes a Task — a genuine inverse pair with `uncompleteTask`, `notes.ts#pinNote`'s own shape. */
export async function completeTask(id: string): Promise<void> {
  await enqueueUserMutation({ type: "completeTask", taskId: id });
  await patchTaskLocally(id, { completed: true, completedAt: new Date().toISOString() });
}

/** Uncompletes a Task, the real inverse of `completeTask`. */
export async function uncompleteTask(id: string): Promise<void> {
  await enqueueUserMutation({ type: "uncompleteTask", taskId: id });
  await patchTaskLocally(id, { completed: false, completedAt: null });
}

/** Moves a Task to a different Section within its own List — an absolute set, self-inverse via the caller's own captured old `sectionId`. */
export async function setTaskSection(id: string, sectionId: string | null): Promise<void> {
  await enqueueUserMutation({ type: "setTaskSection", taskId: id, sectionId });
  await patchTaskLocally(id, { sectionId });
}

/** Moves a Task to a different List, carrying its destination Section too — Sections don't cross Lists. */
export async function setTaskList(
  id: string,
  taskListId: string,
  sectionId: string | null,
): Promise<void> {
  await enqueueUserMutation({ type: "setTaskList", taskId: id, taskListId, sectionId });
  await patchTaskLocally(id, { taskListId, sectionId });
}

/** Reorders a Task within its List/Section — an absolute set, self-inverse via the caller's own captured old `order`. */
export async function reorderTask(id: string, order: number): Promise<void> {
  await enqueueUserMutation({ type: "reorderTask", taskId: id, order });
  await patchTaskLocally(id, { order });
}

/** Soft-deletes a Task — a genuine inverse pair with `restoreTask`, `notes.ts#trashNote`'s own shape. */
export async function trashTask(id: string): Promise<void> {
  await enqueueUserMutation({ type: "trashTask", taskId: id });
  await patchTaskLocally(id, { deletedAt: new Date().toISOString() });
}

/** Restores a Task, the real inverse of `trashTask`. */
export async function restoreTask(id: string): Promise<void> {
  await enqueueUserMutation({ type: "restoreTask", taskId: id });
  await patchTaskLocally(id, { deletedAt: null });
}

/** Applies a Label to a Task (#253) — `notes.ts#labelNote`'s exact shape, over the same User-scoped Label set (#186). */
export async function labelTask(id: string, name: string): Promise<void> {
  await enqueueUserMutation({ type: "labelTask", taskId: id, name });
  await addLabelLocally(id, name);
}

/** Removes a Label from a Task, `notes.ts#unlabelNote`'s shape. */
export async function unlabelTask(id: string, name: string): Promise<void> {
  await enqueueUserMutation({ type: "unlabelTask", taskId: id, name });
  await removeLabelLocally(id, name);
}

/** `session.ts#labelIdForName` is the Client's one place that derives `Label.id` from a name — reused here so a Task's optimistic overlay can never disagree with a Note's or a Thread's. */
async function addLabelLocally(id: string, name: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.tasks, async () => {
    const row = await db.tasks.get(id);
    const labelId = labelIdForName(name);
    if (!row || labelId === null || row.labelIds.includes(labelId)) return;
    await db.tasks.put({ ...row, labelIds: [...row.labelIds, labelId] });
  });
}

async function removeLabelLocally(id: string, name: string): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.tasks, async () => {
    const row = await db.tasks.get(id);
    const labelId = labelIdForName(name);
    if (!row || labelId === null) return;
    await db.tasks.put({ ...row, labelIds: row.labelIds.filter((entry) => entry !== labelId) });
  });
}

async function patchTaskLocally(id: string, patch: Partial<Task>): Promise<void> {
  const db = localCache();
  await db.transaction("rw", db.tasks, async () => {
    const row = await db.tasks.get(id);
    if (!row) return;
    await db.tasks.put({ ...row, ...patch, updatedAt: new Date().toISOString() });
  });
}

/**
 * Writes one body autosave (#251, #250, ADR-0023) — the `documentSaves`
 * channel's write side for the `Task` collection, `notes.ts#saveNoteBody`'s
 * shape with one deliberate difference: a Note's local row can be lazily
 * created from nothing (every other field has a sensible default), a Task's
 * cannot — `taskListId`/`title` are required and this function has neither.
 * The row is only patched when it already exists; `createTask` is what
 * creates it, milliseconds before the first keystroke ever reaches here in
 * practice (the editor mounts against an already-created Task), the same
 * ordering `saveNoteBody`'s own doc comment notes nothing actually
 * requires — the difference is only what happens on the race, not the
 * ordinary path. The queued save itself is written either way: a body edit
 * must never be silently dropped even if the row write is skipped.
 */
export async function saveTaskBody(id: string, document: NoteDocument): Promise<void> {
  const db = localCache();
  const now = new Date().toISOString();
  await db.transaction("rw", [db.tasks, db.pendingTaskSaves], async () => {
    const existing = await db.tasks.get(id);
    if (existing) await db.tasks.put({ ...existing, document, updatedAt: now });
    await db.pendingTaskSaves.put({ taskId: id, saveId: generateUlid(), document, queuedAt: now });
  });
}

/** Every queued body autosave, at most one per Task. */
export async function listQueuedTaskSaves(): Promise<PendingTaskSave[]> {
  return localCache().pendingTaskSaves.toArray();
}

/** This collection's entry on the `documentSaves` channel (#250) — tags a queued row with the `Task` collection key the wire carries it under. */
export function toWireTaskSave(pending: PendingTaskSave): DocumentSave {
  return {
    collection: "Task",
    id: pending.taskId,
    saveId: pending.saveId,
    document: pending.document,
  };
}

/** Dequeues every body save a round trip answered for — `notes.ts#resolveNoteSaveOutcomes`'s own shape. */
export async function resolveTaskSaveOutcomes(
  queued: DocumentSave[],
  outcomes: DocumentSaveOutcome[],
): Promise<void> {
  const ids = new Set(queued.map((save) => save.id));
  const db = localCache();
  for (const outcome of outcomes) {
    if (!ids.has(outcome.id)) continue;
    await db.transaction("rw", db.pendingTaskSaves, async () => {
      const stillQueued = await db.pendingTaskSaves.get(outcome.id);
      if (!stillQueued || stillQueued.saveId !== outcome.saveId) return;
      await db.pendingTaskSaves.delete(outcome.id);
    });
  }
}
