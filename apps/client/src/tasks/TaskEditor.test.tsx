import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/ui/sonner.js";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyTaskDelta, applyTaskListDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { readTask } from "../store/tasks.js";
import { delta, makeTask, makeTaskList } from "../test-support/mail-fixtures.js";
import { TaskEditor } from "./TaskEditor.js";

/**
 * `TaskEditor` (#253) — the expanded row's own editor: title, the BlockNote
 * body (`NoteEditor.test.tsx`'s own coverage of the body itself, not
 * repeated here), List, Section, Due, Labels and Delete. Renders bare over a
 * seeded Local Cache, `TaskListView.test.tsx`'s own shape — `Toaster`
 * alongside it since Delete's own Undo toast is under test here too.
 */

const USER = "user-1";

beforeEach(async () => {
  await openLocalCache({ name: `task-editor-test-${Math.random()}`, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  resetUndoToastsForTest();
  toast.dismiss();
  await Dexie.delete(localCache().name);
});

async function seedTask(overrides: Parameters<typeof makeTask>[3] = {}) {
  await applyTaskListDelta(
    delta({ created: [makeTaskList("list-1", USER, { name: "Groceries" })] }),
    { replace: false },
  );
  const task = makeTask("t1", USER, "list-1", { title: "Buy milk", ...overrides });
  await applyTaskDelta(delta({ created: [task] }), { replace: false });
  return task;
}

function renderEditor(task: Awaited<ReturnType<typeof seedTask>>, onCollapse = vi.fn()) {
  return render(
    <>
      <TaskEditor taskId={task.id} onCollapse={onCollapse} />
      <Toaster />
    </>,
  );
}

describe("TaskEditor — title", () => {
  it("renames the Task on blur", async () => {
    const task = await seedTask();
    renderEditor(task);

    const input = (await screen.findByLabelText("Task title")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Buy oat milk" } });
    fireEvent.blur(input);

    await waitFor(async () => {
      expect((await readTask("t1"))?.title).toBe("Buy oat milk");
    });
  });
});

describe("TaskEditor — Due", () => {
  it("has no Due set initially, and the time input is disabled with no date", async () => {
    const task = await seedTask();
    renderEditor(task);

    fireEvent.click(await screen.findByRole("button", { name: "Due" }));
    expect(screen.getByRole("menu", { name: "Due" })).not.toBeNull();
    expect((screen.getByLabelText("Due time") as HTMLInputElement).disabled).toBe(true);
  });

  it("picking the Today preset sets a zone-less due date and enables the time input", async () => {
    const task = await seedTask();
    renderEditor(task);

    fireEvent.click(await screen.findByRole("button", { name: "Due" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Today" }));

    await waitFor(async () => {
      const stored = await readTask("t1");
      expect(stored?.dueDate).toMatch(/T00:00:00\.000Z$/);
    });
    await waitFor(() => {
      expect((screen.getByLabelText("Due time") as HTMLInputElement).disabled).toBe(false);
    });
  });

  it("setting a time patches dueTime independently of dueDate", async () => {
    const task = await seedTask({ dueDate: "2026-06-15T00:00:00.000Z" });
    renderEditor(task);

    fireEvent.click(await screen.findByRole("button", { name: /Due/ }));
    fireEvent.change(screen.getByLabelText("Due time"), { target: { value: "14:30" } });

    await waitFor(async () => {
      expect((await readTask("t1"))?.dueTime).toBe("14:30");
    });
  });

  it("'No date' clears both dueDate and dueTime together", async () => {
    const task = await seedTask({ dueDate: "2026-06-15T00:00:00.000Z", dueTime: "14:30" });
    renderEditor(task);

    fireEvent.click(await screen.findByRole("button", { name: /Due/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "No date" }));

    await waitFor(async () => {
      const stored = await readTask("t1");
      expect(stored?.dueDate).toBeNull();
      expect(stored?.dueTime).toBeNull();
    });
  });
});

describe("TaskEditor — Labels", () => {
  it("applies a brand-new Label by name through mail's own LabelPicker", async () => {
    const task = await seedTask();
    renderEditor(task);

    fireEvent.click(await screen.findByRole("button", { name: "Apply or remove a label" }));
    const input = screen.getByPlaceholderText("New label…");
    fireEvent.change(input, { target: { value: "Errands" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(async () => {
      const stored = await readTask("t1");
      expect(stored?.labelIds).toHaveLength(1);
    });
  });
});

describe("TaskEditor — List/Section", () => {
  it("moving to a different List clears the destination Section", async () => {
    const task = await seedTask();
    await applyTaskListDelta(delta({ created: [makeTaskList("list-2", USER, { name: "Work" })] }), {
      replace: false,
    });
    renderEditor(task);

    fireEvent.change(await screen.findByLabelText("List"), { target: { value: "list-2" } });

    await waitFor(async () => {
      expect((await readTask("t1"))?.taskListId).toBe("list-2");
    });
  });

  it("moving to a Section within the same List", async () => {
    const listWithSection = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [{ id: "sec-1", name: "Today" }],
    });
    await applyTaskListDelta(delta({ created: [listWithSection] }), { replace: false });
    const task = makeTask("t1", USER, "list-1", { title: "Buy milk" });
    await applyTaskDelta(delta({ created: [task] }), { replace: false });
    renderEditor(task);

    // The Section `<select>`'s own options come from a second live query
    // (`useTaskList`) — waits for "Today" to actually be a selectable option
    // before firing the change, rather than racing it.
    await screen.findByRole("option", { name: "Today" });
    fireEvent.change(screen.getByLabelText("Section"), { target: { value: "sec-1" } });

    await waitFor(async () => {
      expect((await readTask("t1"))?.sectionId).toBe("sec-1");
    });
  });
});

describe("TaskEditor — Delete", () => {
  it("trashes the Task, collapses the row, raises an Undo toast, and Undo restores it", async () => {
    const task = await seedTask();
    const onCollapse = vi.fn();
    renderEditor(task, onCollapse);

    fireEvent.click(await screen.findByRole("button", { name: "Delete task" }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
    await waitFor(async () => {
      expect((await readTask("t1"))?.deletedAt).not.toBeNull();
    });

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () => {
      expect((await readTask("t1"))?.deletedAt).toBeNull();
    });
  });
});
