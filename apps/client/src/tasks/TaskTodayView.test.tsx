import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/ui/sonner.js";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyTaskDelta, applyTaskListDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { readTasks } from "../store/tasks.js";
import { delta, makeTask, makeTaskList } from "../test-support/mail-fixtures.js";
import { TaskTodayView } from "./TaskTodayView.js";
import { addLocalDays, dateOnlyToWireDueDate, localDateInputValue } from "./task-due.js";

/**
 * `TaskTodayView` reads its own live query (`useTodayTasks`) with the real
 * clock (`store/tasks.test.ts#"readTodayTasks / readUpcomingTasks"` is where
 * `now` is pinned) — every fixture here is built relative to the actual
 * "today" (`localDateInputValue(new Date())`/`addLocalDays`), never a fixed
 * date, so this suite never rots as the calendar moves on.
 */

const USER = "user-1";
const TODAY = dateOnlyToWireDueDate(localDateInputValue(new Date()));
const YESTERDAY = dateOnlyToWireDueDate(addLocalDays(new Date(), -1));
const TOMORROW = dateOnlyToWireDueDate(addLocalDays(new Date(), 1));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `task-today-view-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  await applyTaskListDelta(
    delta({ created: [makeTaskList("list-1", USER, { name: "Tasks", isDefault: true })] }),
    { replace: false },
  );
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  resetUndoToastsForTest();
  toast.dismiss();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

function renderTodayView() {
  return render(
    <>
      <TaskTodayView onBack={vi.fn()} />
      <Toaster />
    </>,
  );
}

describe("TaskTodayView (#254)", () => {
  it("shows every Task due today or overdue, across Lists, and excludes a future or undated one", async () => {
    await applyTaskListDelta(delta({ created: [makeTaskList("list-2", USER, { name: "Work" })] }), {
      replace: false,
    });
    await applyTaskDelta(
      delta({
        created: [
          makeTask("overdue", USER, "list-1", { title: "Overdue", dueDate: YESTERDAY }),
          makeTask("today", USER, "list-2", { title: "Due today", dueDate: TODAY }),
          makeTask("future", USER, "list-1", { title: "Later", dueDate: TOMORROW }),
          makeTask("undated", USER, "list-1", { title: "No due date" }),
        ],
      }),
      { replace: false },
    );

    renderTodayView();

    expect(await screen.findByRole("button", { name: "Overdue" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Due today" })).toBeDefined();
    expect(screen.queryByText("Later")).toBeNull();
    expect(screen.queryByText("No due date")).toBeNull();
  });

  it("quick add creates a Task in the default List due today, and it appears at once", async () => {
    renderTodayView();

    // Quick add's own `defaultList` comes from `useTaskLists()`'s live query
    // (`TaskTodayView.tsx#addTask`'s own guard), which resolves asynchronously
    // relative to this test's own synchronous fire — retrying the submit is
    // this suite's own way of not racing that, `waitFor`'s standard shape.
    await waitFor(async () => {
      const input = screen.getByLabelText("Add a task");
      fireEvent.change(input, { target: { value: "Buy milk" } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      expect(await readTasks("list-1")).not.toHaveLength(0);
    });

    expect(await screen.findByRole("button", { name: "Buy milk" })).toBeDefined();
    const tasks = await readTasks("list-1");
    expect(tasks[0]).toMatchObject({ title: "Buy milk", dueDate: TODAY });
  });

  it("completing a Task behaves exactly as from a List, including the Undo toast and 'N completed' expander", async () => {
    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk", dueDate: TODAY })] }),
      { replace: false },
    );

    renderTodayView();
    const checkbox = await screen.findByRole("checkbox", { name: 'Mark "Buy milk" done' });
    fireEvent.click(checkbox);

    await screen.findByText("1 completed");
    const undoButton = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undoButton);

    await waitFor(() => {
      expect(screen.queryByText("1 completed")).toBeNull();
    });
    const expander = screen.queryByText("1 completed");
    expect(expander).toBeNull();
    expect(screen.getByRole("checkbox", { name: 'Mark "Buy milk" done' })).toBeDefined();
  });

  it("no Board mode control renders", async () => {
    renderTodayView();
    await screen.findByRole("region", { name: "Today" });
    expect(screen.queryByRole("button", { name: /board/i })).toBeNull();
  });

  it("a row expands in place", async () => {
    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk", dueDate: TODAY })] }),
      { replace: false },
    );

    renderTodayView();
    fireEvent.click(await screen.findByRole("button", { name: "Buy milk" }));

    expect(await screen.findByDisplayValue("Buy milk")).toBeDefined();
  });
});
