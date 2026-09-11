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
import { TaskUpcomingView } from "./TaskUpcomingView.js";
import { addLocalDays, dateOnlyToWireDueDate, localDateInputValue } from "./task-due.js";

/** `TaskTodayView.test.tsx`'s own doc comment on why every fixture here is built relative to the real "today", never a fixed date. */

const USER = "user-1";
const TODAY = dateOnlyToWireDueDate(localDateInputValue(new Date()));
const TOMORROW = dateOnlyToWireDueDate(addLocalDays(new Date(), 1));
const IN_TWO_DAYS = dateOnlyToWireDueDate(addLocalDays(new Date(), 2));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `task-upcoming-view-test-${counter++}`;
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

function renderUpcomingView() {
  return render(
    <>
      <TaskUpcomingView onBack={vi.fn()} />
      <Toaster />
    </>,
  );
}

describe("TaskUpcomingView (#254)", () => {
  it("groups Tasks due after today by day, across Lists, earliest first — excluding today's own and undated Tasks", async () => {
    await applyTaskListDelta(delta({ created: [makeTaskList("list-2", USER, { name: "Work" })] }), {
      replace: false,
    });
    await applyTaskDelta(
      delta({
        created: [
          makeTask("t2", USER, "list-2", { title: "Second day", dueDate: IN_TWO_DAYS }),
          makeTask("t1", USER, "list-1", { title: "First day", dueDate: TOMORROW }),
          makeTask("today", USER, "list-1", { title: "Due today", dueDate: TODAY }),
          makeTask("undated", USER, "list-1", { title: "No due date" }),
        ],
      }),
      { replace: false },
    );

    renderUpcomingView();

    const headings = (await screen.findAllByRole("heading", { level: 3 })).map(
      (heading) => heading.textContent,
    );
    expect(headings).toHaveLength(2);
    expect(screen.getByText("First day")).toBeDefined();
    expect(screen.getByText("Second day")).toBeDefined();
    expect(screen.queryByText("Due today")).toBeNull();
    expect(screen.queryByText("No due date")).toBeNull();
  });

  it("each day group's own quick add creates a Task due that day in the default List, appearing in that group at once", async () => {
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "First day", dueDate: TOMORROW })],
      }),
      { replace: false },
    );

    renderUpcomingView();
    await screen.findByLabelText(/Add a task for/);

    // Quick add's own `defaultList` comes from `useTaskLists()`'s live query
    // (`TaskUpcomingView.tsx#addTaskForDay`'s own guard), which resolves
    // asynchronously relative to this test's own synchronous fire — retrying
    // the submit is this suite's own way of not racing that.
    await waitFor(async () => {
      const input = screen.getByLabelText(/Add a task for/);
      fireEvent.change(input, { target: { value: "Buy milk" } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      expect(await readTasks("list-1")).not.toHaveLength(0);
    });

    expect(await screen.findByRole("button", { name: "Buy milk" })).toBeDefined();
    const created = (await readTasks("list-1")).find((task) => task.title === "Buy milk");
    expect(created).toMatchObject({ dueDate: TOMORROW });
  });

  it("completing a Task behaves exactly as from a List, Undo included, and it lands in the one view-wide 'N completed' expander", async () => {
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", dueDate: TOMORROW })],
      }),
      { replace: false },
    );

    renderUpcomingView();
    fireEvent.click(await screen.findByRole("checkbox", { name: 'Mark "Buy milk" done' }));

    await screen.findByText("1 completed");
    const undoButton = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undoButton);

    await waitFor(() => {
      expect(screen.queryByText("1 completed")).toBeNull();
    });
    expect(screen.getByRole("checkbox", { name: 'Mark "Buy milk" done' })).toBeDefined();
  });

  it("no Board mode control renders", async () => {
    renderUpcomingView();
    await screen.findByRole("region", { name: "Upcoming" });
    expect(screen.queryByRole("button", { name: /board/i })).toBeNull();
  });

  it("a row expands in place", async () => {
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", dueDate: TOMORROW })],
      }),
      { replace: false },
    );

    renderUpcomingView();
    fireEvent.click(await screen.findByRole("button", { name: "Buy milk" }));

    expect(await screen.findByDisplayValue("Buy milk")).toBeDefined();
  });
});
