import type { NoteDocument } from "@mail/shared";
import { EMPTY_NOTE_DOCUMENT } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateOnlyToWireDueDate } from "../tasks/task-due.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { setSessionUserId } from "./session.js";
import {
  completeTask,
  createSection,
  createTask,
  createTaskFromThreadLink,
  createTaskList,
  deleteSection,
  deleteTask,
  deleteTaskList,
  listQueuedTaskSaves,
  newSectionId,
  newTaskId,
  newTaskListId,
  readAllTasks,
  readDeletedTaskLists,
  readDeletedTasks,
  readOpenTasksForThread,
  readTask,
  readTaskList,
  readTaskLists,
  readTasks,
  readTodayTasks,
  readUpcomingTasks,
  renameSection,
  renameTaskList,
  reorderSections,
  reorderTask,
  reorderTaskList,
  resolveTaskSaveOutcomes,
  restoreSection,
  restoreTask,
  restoreTaskList,
  saveTaskBody,
  setTaskDueDate,
  setTaskDueTime,
  setTaskList,
  setTaskSection,
  setTaskTitle,
  taskExists,
  toWireTaskSave,
  trashTask,
  uncompleteTask,
} from "./tasks.js";
import { listQueuedUserMutations } from "./user-mutation-queue.js";

/**
 * #251's own acceptance lines: Task List/Task/Section ids are client-minted
 * ULIDs, present before any server round trip; every structural write rides
 * the User-scoped Optimistic Action queue with a real inverse (ADR-0019); a
 * Task's body edits ride `pendingTaskSaves` — `notes.test.ts`'s own template.
 */

const USER = "user-1";

function defined<T>(value: T | undefined | null): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

const requestSyncNow = vi.fn();
vi.mock("../sync/sync-loop.js", () => ({
  requestSyncNow: () => requestSyncNow(),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `tasks-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  requestSyncNow.mockClear();
});

afterEach(async () => {
  localCache().close();
  setSessionUserId(null);
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function drainQueue(): Promise<void> {
  const queued = await listQueuedUserMutations();
  await localCache().pendingUserMutations.bulkDelete(queued.map((mutation) => mutation.id));
}

describe("newTaskListId / newTaskId / newSectionId", () => {
  it("each mints a fresh, offline-derivable ULID", () => {
    for (const mint of [newTaskListId, newTaskId, newSectionId]) {
      const id = mint();
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
      expect(mint()).not.toBe(id);
    }
  });
});

describe("createTaskList", () => {
  it("writes the durable row optimistically — no Sections, not the default", async () => {
    const id = newTaskListId();

    await createTaskList(id, "Errands");

    const row = defined(await readTaskList(id));
    expect(row).toMatchObject({
      id,
      userId: USER,
      name: "Errands",
      sections: [],
      isDefault: false,
    });
  });

  it("enqueues createTaskList on the User-scoped queue", async () => {
    const id = newTaskListId();

    await createTaskList(id, "Errands");

    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "createTaskList",
      taskListId: id,
      name: "Errands",
    });
    expect(requestSyncNow).toHaveBeenCalled();
  });

  it("appears in readTaskLists, ordered", async () => {
    const a = newTaskListId();
    const b = newTaskListId();
    await createTaskList(a, "A");
    await createTaskList(b, "B");
    await reorderTaskList(a, 2);
    await reorderTaskList(b, 1);

    const lists = await readTaskLists();
    expect(lists.map((list) => list.id)).toEqual([b, a]);
  });
});

describe("renameTaskList / reorderTaskList", () => {
  it("patches optimistically and enqueues an absolute-set intent", async () => {
    const id = newTaskListId();
    await createTaskList(id, "Errands");
    await drainQueue();

    await renameTaskList(id, "Chores");
    await reorderTaskList(id, 5);

    const row = defined(await readTaskList(id));
    expect(row).toMatchObject({ name: "Chores", order: 5 });
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toEqual([
      { type: "renameTaskList", taskListId: id, name: "Chores" },
      { type: "reorderTaskList", taskListId: id, order: 5 },
    ]);
  });
});

describe("deleteTaskList / restoreTaskList", () => {
  it("soft-deletes the List and cascades to its own live Tasks, returning the captured ids", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const taskId = newTaskId();
    await createTask(taskId, listId, null, "Buy milk");
    const otherListId = newTaskListId();
    await createTaskList(otherListId, "Other");
    const otherTaskId = newTaskId();
    await createTask(otherTaskId, otherListId, null, "Not this list");

    const taskIds = await deleteTaskList(listId);

    expect(taskIds).toEqual([taskId]);
    expect((await readTaskList(listId))?.deletedAt).not.toBeNull();
    expect((await readTask(taskId))?.deletedAt).not.toBeNull();
    expect((await readTask(otherTaskId))?.deletedAt).toBeNull();
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "deleteTaskList",
      taskListId: listId,
      taskIds: [taskId],
    });
  });

  it("restores the List and exactly the Tasks it took, the real inverse of deleteTaskList", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const taskId = newTaskId();
    await createTask(taskId, listId, null, "Buy milk");
    const taskIds = await deleteTaskList(listId);
    await drainQueue();

    await restoreTaskList(listId, taskIds);

    expect((await readTaskList(listId))?.deletedAt).toBeNull();
    expect((await readTask(taskId))?.deletedAt).toBeNull();
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "restoreTaskList",
      taskListId: listId,
      taskIds,
    });
  });
});

describe("Section", () => {
  it("createSection appends to the List's ordered array and returns the minted id", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");

    const sectionId = await createSection(listId, "Today");

    const row = defined(await readTaskList(listId));
    expect(row.sections).toEqual([{ id: sectionId, name: "Today" }]);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "createSection",
      taskListId: listId,
      sectionId,
      name: "Today",
    });
  });

  it("renameSection patches the array entry in place", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const sectionId = await createSection(listId, "Today");
    await drainQueue();

    await renameSection(listId, sectionId, "This week");

    expect((await readTaskList(listId))?.sections).toEqual([{ id: sectionId, name: "This week" }]);
  });

  it("reorderSections replaces the whole order", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const a = await createSection(listId, "A");
    const b = await createSection(listId, "B");
    await drainQueue();

    await reorderSections(listId, [b, a]);

    expect((await readTaskList(listId))?.sections.map((section) => section.id)).toEqual([b, a]);
  });

  it("deleteSection moves its own live Tasks to the List's first remaining Section, returning the capture restoreSection needs", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const first = await createSection(listId, "A");
    const second = await createSection(listId, "B");
    const taskId = newTaskId();
    await createTask(taskId, listId, second, "Buy milk");

    const deleted = defined(await deleteSection(listId, second));

    expect(deleted).toMatchObject({ sectionId: second, name: "B", index: 1, taskIds: [taskId] });
    expect((await readTaskList(listId))?.sections).toEqual([{ id: first, name: "A" }]);
    expect((await readTask(taskId))?.sectionId).toBe(first);
  });

  it("restoreSection reinserts at the captured index and returns the Tasks to it — the real inverse of deleteSection", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const first = await createSection(listId, "A");
    const second = await createSection(listId, "B");
    const taskId = newTaskId();
    await createTask(taskId, listId, second, "Buy milk");
    const deleted = defined(await deleteSection(listId, second));
    await drainQueue();

    await restoreSection(listId, deleted);

    expect((await readTaskList(listId))?.sections).toEqual([
      { id: first, name: "A" },
      { id: second, name: "B" },
    ]);
    expect((await readTask(taskId))?.sectionId).toBe(second);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "restoreSection",
      taskListId: listId,
      sectionId: second,
      name: "B",
      index: 1,
      taskIds: [taskId],
    });
  });
});

describe("createTask / deleteTask", () => {
  it("writes the durable row optimistically — empty body, incomplete", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();

    await createTask(id, listId, null, "Buy milk", 1);

    const row = defined(await readTask(id));
    expect(row).toMatchObject({
      id,
      userId: USER,
      taskListId: listId,
      sectionId: null,
      title: "Buy milk",
      completed: false,
      order: 1,
      threadLink: null,
    });
    expect(row.document).toEqual(EMPTY_NOTE_DOCUMENT);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "createTask",
      taskId: id,
      taskListId: listId,
      sectionId: null,
      title: "Buy milk",
      order: 1,
      threadLink: null,
    });
  });

  it("createTaskFromThreadLink (#258) sets the Thread Link field, never the body, and commits a Due when given", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");

    const id = await createTaskFromThreadLink(
      listId,
      "Reply to Ada",
      {
        threadId: "t1",
        subject: "Reply to Ada",
        participants: "Ada Lovelace",
        date: "2026-06-01T12:00:00.000Z",
      },
      "2026-06-02T00:00:00.000Z",
    );

    const row = defined(await readTask(id));
    expect(row.threadLink).toEqual({
      threadId: "t1",
      subject: "Reply to Ada",
      participants: "Ada Lovelace",
      date: "2026-06-01T12:00:00.000Z",
    });
    expect(row.dueDate).toBe("2026-06-02T00:00:00.000Z");
    // "The mail itself is never copied into the Task" — no body write at all.
    expect(row.document).toEqual(EMPTY_NOTE_DOCUMENT);
  });

  it("removes the local row and any queued body save, cancelling with the still-queued create (ADR-0019)", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    await drainQueue();
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await saveTaskBody(id, []);

    await deleteTask(id);

    expect(await readTask(id)).toBeUndefined();
    expect(await listQueuedTaskSaves()).toEqual([]);
    expect(await listQueuedUserMutations()).toEqual([]);
  });

  it("appears in readTasks for its List, ordered", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const a = newTaskId();
    const b = newTaskId();
    await createTask(a, listId, null, "A", 2);
    await createTask(b, listId, null, "B", 1);

    const rows = await readTasks(listId);
    expect(rows.map((row) => row.id)).toEqual([b, a]);
  });
});

describe("readAllTasks (#262)", () => {
  it("spans every live List, excludes a soft-deleted Task and one whose List is soft-deleted", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const otherListId = newTaskListId();
    await createTaskList(otherListId, "Groceries");

    const live = newTaskId();
    await createTask(live, listId, null, "Live task");
    const trashed = newTaskId();
    await createTask(trashed, listId, null, "Trashed task");
    await trashTask(trashed);
    const orphaned = newTaskId();
    await createTask(orphaned, otherListId, null, "Orphaned by deleted List");
    await deleteTaskList(otherListId);

    const rows = await readAllTasks();
    expect(rows.map((row) => row.id)).toEqual([live]);
  });
});

describe("readOpenTasksForThread (#259)", () => {
  it("returns only the open Tasks whose Thread Link field names the Thread", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const threadLink = {
      threadId: "t1",
      subject: "Reply to Ada",
      participants: "Ada Lovelace",
      date: "2026-06-01T12:00:00.000Z",
    };

    const linked = await createTaskFromThreadLink(listId, "Reply to Ada", threadLink);
    const otherThread = await createTaskFromThreadLink(listId, "Reply to Bob", {
      ...threadLink,
      threadId: "t2",
    });
    const unlinked = newTaskId();
    await createTask(unlinked, listId, null, "Unrelated");

    const rows = await readOpenTasksForThread("t1");
    expect(rows.map((row) => row.id)).toEqual([linked]);
    expect(otherThread).not.toEqual(linked);
    expect(unlinked).not.toEqual(linked);
  });

  it("excludes a completed Task and a soft-deleted one, even with a matching Thread Link field", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const threadLink = {
      threadId: "t1",
      subject: "Reply to Ada",
      participants: "Ada Lovelace",
      date: "2026-06-01T12:00:00.000Z",
    };

    const completed = await createTaskFromThreadLink(listId, "Done already", threadLink);
    await completeTask(completed);
    const trashed = await createTaskFromThreadLink(listId, "Trashed", threadLink);
    await trashTask(trashed);

    expect(await readOpenTasksForThread("t1")).toEqual([]);
  });
});

describe("setTaskTitle / setTaskDueDate", () => {
  it("patches each field independently", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();

    await setTaskTitle(id, "Buy oat milk");
    await setTaskDueDate(id, "2026-06-01T08:00:00.000Z");

    const row = defined(await readTask(id));
    expect(row.title).toBe("Buy oat milk");
    expect(row.dueDate).toBe("2026-06-01T08:00:00.000Z");
  });
});

describe("completeTask / uncompleteTask", () => {
  it("is a genuine inverse pair", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();

    await completeTask(id);
    let row = defined(await readTask(id));
    expect(row.completed).toBe(true);
    expect(row.completedAt).not.toBeNull();

    await uncompleteTask(id);
    row = defined(await readTask(id));
    expect(row.completed).toBe(false);
    expect(row.completedAt).toBeNull();
  });
});

describe("setTaskSection / setTaskList", () => {
  it("moves a Task within its own List", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const sectionId = await createSection(listId, "Today");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();

    await setTaskSection(id, sectionId);

    expect((await readTask(id))?.sectionId).toBe(sectionId);
  });

  it("moves a Task to a different List, carrying its destination Section", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const destinationId = newTaskListId();
    await createTaskList(destinationId, "Chores");
    const destinationSection = await createSection(destinationId, "Today");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();

    await setTaskList(id, destinationId, destinationSection);

    const row = defined(await readTask(id));
    expect(row.taskListId).toBe(destinationId);
    expect(row.sectionId).toBe(destinationSection);
  });
});

describe("reorderTask", () => {
  it("patches order optimistically", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();

    await reorderTask(id, 2.5);

    expect((await readTask(id))?.order).toBe(2.5);
  });
});

describe("trashTask / restoreTask", () => {
  it("is a genuine inverse pair distinct from deleteTask", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();

    await trashTask(id);
    expect((await readTask(id))?.deletedAt).not.toBeNull();
    // Excluded from readTasks — a trashed Task's list read is caught up
    // in that filter same as `readNotes` filters `deletedAt`.
    expect(await readTasks(listId)).toEqual([]);

    await restoreTask(id);
    expect((await readTask(id))?.deletedAt).toBeNull();
  });
});

describe("taskExists (#257)", () => {
  it("is true for a live Task in a live List", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");

    expect(await taskExists(id)).toBe(true);
  });

  it("is false once the Task itself is soft-deleted", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await trashTask(id);

    expect(await taskExists(id)).toBe(false);
  });

  it("is false for a still-live Task whose List is soft-deleted", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();
    await deleteTaskList(listId);

    expect(await taskExists(id)).toBe(false);
  });

  it("is false for an unknown id", async () => {
    expect(await taskExists("nope")).toBe(false);
  });
});

describe("readDeletedTasks (Recently Deleted, #257)", () => {
  it("lists only Tasks deleted on their own, most recently deleted first", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const kept = newTaskId();
    const a = newTaskId();
    const b = newTaskId();
    await createTask(kept, listId, null, "Kept");
    await createTask(a, listId, null, "A");
    await createTask(b, listId, null, "B");
    await trashTask(a);
    await trashTask(b);
    // Bump b's deletedAt ahead of a's without depending on real clock ordering.
    const row = defined(await readTask(b));
    await localCache().tasks.put({ ...row, deletedAt: "2099-01-01T00:00:00.000Z" });

    expect((await readDeletedTasks()).map((task) => task.id)).toEqual([b, a]);
  });

  it("excludes a Task whose own List is also soft-deleted — it surfaces only under the List's entry", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await drainQueue();
    await deleteTaskList(listId);

    expect(await readDeletedTasks()).toEqual([]);
  });
});

describe("readDeletedTaskLists (Recently Deleted, #257)", () => {
  it("lists a deleted List with the ids of every Task it cascaded onto", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const t1 = newTaskId();
    const t2 = newTaskId();
    await createTask(t1, listId, null, "Buy milk");
    await createTask(t2, listId, null, "Walk dog");
    await drainQueue();

    const taskIds = await deleteTaskList(listId);

    const entries = await readDeletedTaskLists();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.list.id).toBe(listId);
    expect(new Set(entries[0]?.taskIds)).toEqual(new Set(taskIds));
    expect(new Set(entries[0]?.taskIds)).toEqual(new Set([t1, t2]));
  });

  it("excludes a still-live List", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");

    expect(await readDeletedTaskLists()).toEqual([]);
  });
});

describe("readTodayTasks / readUpcomingTasks (#254)", () => {
  const NOW = new Date(2026, 5, 15, 9, 0, 0); // "Today" = 2026-06-15, local
  const YESTERDAY = dateOnlyToWireDueDate("2026-06-14");
  const TODAY = dateOnlyToWireDueDate("2026-06-15");
  const TOMORROW = dateOnlyToWireDueDate("2026-06-16");
  const IN_TWO_DAYS = dateOnlyToWireDueDate("2026-06-17");

  async function seedAcrossLists() {
    const listA = newTaskListId();
    const listB = newTaskListId();
    await createTaskList(listA, "List A");
    await createTaskList(listB, "List B");
    return { listA, listB };
  }

  describe("readTodayTasks", () => {
    it("gathers every overdue Task and every Task due today, across Lists, excluding future and undated ones", async () => {
      const { listA, listB } = await seedAcrossLists();
      const overdue = newTaskId();
      const dueToday = newTaskId();
      const future = newTaskId();
      const undated = newTaskId();
      await createTask(overdue, listA, null, "Overdue");
      await setTaskDueDate(overdue, YESTERDAY);
      await createTask(dueToday, listB, null, "Due today");
      await setTaskDueDate(dueToday, TODAY);
      await createTask(future, listA, null, "Later");
      await setTaskDueDate(future, TOMORROW);
      await createTask(undated, listB, null, "No due date");

      const rows = await readTodayTasks(NOW);

      expect(new Set(rows.map((row) => row.id))).toEqual(new Set([overdue, dueToday]));
    });

    it("sorts by due time then by manual order, mixing Lists freely", async () => {
      const { listA, listB } = await seedAcrossLists();
      const late = newTaskId();
      const early = newTaskId();
      const noTime = newTaskId();
      await createTask(late, listA, null, "Late", 3);
      await setTaskDueDate(late, TODAY);
      await setTaskDueTime(late, "15:00");
      await createTask(early, listB, null, "Early", 1);
      await setTaskDueDate(early, YESTERDAY);
      await setTaskDueTime(early, "09:00");
      await createTask(noTime, listA, null, "No time", 2);
      await setTaskDueDate(noTime, TODAY);

      const rows = await readTodayTasks(NOW);

      expect(rows.map((row) => row.id)).toEqual([noTime, early, late]);
    });

    it("includes a completed Task, same as readTasks", async () => {
      const { listA } = await seedAcrossLists();
      const id = newTaskId();
      await createTask(id, listA, null, "Done already");
      await setTaskDueDate(id, TODAY);
      await completeTask(id);

      const rows = await readTodayTasks(NOW);

      expect(rows.map((row) => row.id)).toEqual([id]);
    });

    it("excludes a soft-deleted Task", async () => {
      const { listA } = await seedAcrossLists();
      const id = newTaskId();
      await createTask(id, listA, null, "Gone");
      await setTaskDueDate(id, TODAY);
      await trashTask(id);

      expect(await readTodayTasks(NOW)).toEqual([]);
    });
  });

  describe("readUpcomingTasks", () => {
    it("groups every Task due after today by day, across Lists, earliest day first", async () => {
      const { listA, listB } = await seedAcrossLists();
      const dueToday = newTaskId();
      const dayOne = newTaskId();
      const dayTwo = newTaskId();
      const undated = newTaskId();
      await createTask(dueToday, listA, null, "Due today");
      await setTaskDueDate(dueToday, TODAY);
      await createTask(dayOne, listB, null, "Day one");
      await setTaskDueDate(dayOne, TOMORROW);
      await createTask(dayTwo, listA, null, "Day two");
      await setTaskDueDate(dayTwo, IN_TWO_DAYS);
      await createTask(undated, listB, null, "No due date");

      const groups = await readUpcomingTasks(NOW);

      expect(groups.map((group) => group.dueDate)).toEqual([TOMORROW, IN_TWO_DAYS]);
      expect(groups[0]?.tasks.map((task) => task.id)).toEqual([dayOne]);
      expect(groups[1]?.tasks.map((task) => task.id)).toEqual([dayTwo]);
    });

    it("sorts each day's own Tasks by due time then manual order", async () => {
      const { listA, listB } = await seedAcrossLists();
      const late = newTaskId();
      const early = newTaskId();
      await createTask(late, listA, null, "Late", 2);
      await setTaskDueDate(late, TOMORROW);
      await setTaskDueTime(late, "15:00");
      await createTask(early, listB, null, "Early", 1);
      await setTaskDueDate(early, TOMORROW);
      await setTaskDueTime(early, "09:00");

      const groups = await readUpcomingTasks(NOW);

      expect(groups).toHaveLength(1);
      expect(groups[0]?.tasks.map((task) => task.id)).toEqual([early, late]);
    });
  });
});

describe("saveTaskBody / documentSaves queue", () => {
  const document: NoteDocument = [
    { id: "b1", type: "paragraph", props: {}, content: [], children: [] },
  ];

  it("writes the row's document and queues a save, coalescing a later edit over an unflushed one", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");

    await saveTaskBody(id, document);
    const firstQueued = defined((await listQueuedTaskSaves())[0]);

    await saveTaskBody(id, []);
    const queued = await listQueuedTaskSaves();

    expect(queued).toHaveLength(1);
    expect(queued[0]?.saveId).not.toBe(firstQueued.saveId);
    expect((await readTask(id))?.document).toEqual([]);
  });

  it("toWireTaskSave tags the queued row with the Task collection key", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await saveTaskBody(id, document);

    const pending = defined((await listQueuedTaskSaves())[0]);
    expect(toWireTaskSave(pending)).toEqual({
      collection: "Task",
      id,
      saveId: pending.saveId,
      document,
    });
  });

  it("resolveTaskSaveOutcomes dequeues only a save whose saveId still matches", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Errands");
    const id = newTaskId();
    await createTask(id, listId, null, "Buy milk");
    await saveTaskBody(id, document);
    const queued = (await listQueuedTaskSaves()).map(toWireTaskSave);

    // A newer save coalesces in before the outcome for the first arrives.
    await saveTaskBody(id, []);
    await resolveTaskSaveOutcomes(queued, [
      { collection: "Task", id, saveId: queued[0]?.saveId as string, status: "applied" },
    ]);

    // The stale outcome must not dequeue the newer, still-unflushed save.
    expect(await listQueuedTaskSaves()).toHaveLength(1);
  });
});
