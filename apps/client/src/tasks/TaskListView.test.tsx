import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Dexie from "dexie";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/ui/sonner.js";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyTaskDelta, applyTaskListDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { readTask, readTaskList, readTasks } from "../store/tasks.js";
import { delta, makeTask, makeTaskList } from "../test-support/mail-fixtures.js";
import { TaskListView } from "./TaskListView.js";

/**
 * `TaskListView` takes a `TaskList` and renders its own live query over
 * `useTasks` — no router dependency, and (unlike `TasksApp`) no
 * `useLocalCacheSync()` of its own either, so this renders bare over a
 * seeded Local Cache, `NoteDialog.test.tsx`'s own shape. `Toaster` renders
 * alongside it (`mail/MailSection.test.tsx`'s own shape) rather than
 * mocking `sonner` to a no-op — the Undo toast this component raises is
 * itself under test here, not just the store write behind it.
 */

const USER = "user-1";
const LIST = makeTaskList("list-1", USER, { name: "Groceries" });
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `task-list-view-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  resetUndoToastsForTest();
  // Sonner's own toast store lives outside React (`mail/MailSection.test.tsx`'s
  // own doc comment) — a toast this file raised but never dismissed (its own
  // timer not yet due) would otherwise bleed into the next file's Toaster.
  toast.dismiss();
  // Board mode/swimlane are real `localStorage` Device Preferences (#256),
  // not the Local Cache this file already tears down above — left alone,
  // one test's "list-1" write would leak into the next test's own render of
  // the same id.
  localStorage.clear();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

function renderTaskListView(props: Partial<Parameters<typeof TaskListView>[0]> = {}) {
  return render(
    <>
      <TaskListView taskList={LIST} onBack={vi.fn()} {...props} />
      <Toaster />
    </>,
  );
}

/**
 * A fake `DataTransfer` (#255): jsdom implements neither `DataTransfer` nor
 * native drag-and-drop, so every drag test here hand-rolls the one sliver
 * `TaskListView.tsx`'s own native HTML5 drag actually reads/writes —
 * `setData`/`getData` backed by a plain `Map`, `types` its live key list.
 * The same instance rides both the `dragStart` and the `drop` `fireEvent`
 * call in a test, `TaskListView.tsx`'s own two calls against one real drag
 * gesture's single `DataTransfer`.
 */
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "",
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return [...store.keys()];
    },
  };
}

describe("TaskListView (#252)", () => {
  it("the back control calls onBack", async () => {
    const onBack = vi.fn();
    renderTaskListView({ onBack });

    fireEvent.click(screen.getByRole("button", { name: "Back to Task Lists" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders every live Task grouped under one implicit group when the List has no Sections yet", async () => {
    await applyTaskDelta(
      delta({
        created: [
          makeTask("t1", USER, "list-1", { title: "Buy milk", order: 0 }),
          makeTask("t2", USER, "list-1", { title: "Walk the dog", order: 1 }),
        ],
      }),
      { replace: false },
    );

    renderTaskListView();

    const rows = await screen.findAllByRole("checkbox");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      'Mark "Buy milk" done',
      'Mark "Walk the dog" done',
    ]);
  });

  it("quick add creates a Task in the List's first Section, at the top, with no Due, and keeps focus", async () => {
    const listWithSection = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [{ id: "sec-1", name: "Backlog" }],
    });
    renderTaskListView({ taskList: listWithSection });

    const input = screen.getByLabelText("Add a task");
    fireEvent.change(input, { target: { value: "Buy milk" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(async () => {
      const tasks = await readTasks("list-1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ title: "Buy milk", sectionId: "sec-1", dueDate: null });
    });
    expect((input as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("quick add never parses a date out of the typed text", async () => {
    renderTaskListView();

    const input = screen.getByLabelText("Add a task");
    fireEvent.change(input, { target: { value: "buy milk tomorrow" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(async () => {
      const tasks = await readTasks("list-1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe("buy milk tomorrow");
      expect(tasks[0]?.dueDate).toBeNull();
    });
  });

  it("ticking a row's checkbox completes it optimistically, raises an Undo toast, and Undo uncompletes it", async () => {
    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk" })] }),
      {
        replace: false,
      },
    );

    renderTaskListView();
    const checkbox = await screen.findByRole("checkbox", { name: 'Mark "Buy milk" done' });
    fireEvent.click(checkbox);

    await waitFor(async () => {
      expect((await readTask("t1"))?.completed).toBe(true);
    });

    const undoButton = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undoButton);

    await waitFor(async () => {
      expect((await readTask("t1"))?.completed).toBe(false);
    });
  });

  it("a completed Task leaves the active rows and appears in the 'N completed' expander, newest completedAt first", async () => {
    await applyTaskDelta(
      delta({
        created: [
          makeTask("t1", USER, "list-1", {
            title: "First done",
            completed: true,
            completedAt: "2026-06-01T12:00:00.000Z",
          }),
          makeTask("t2", USER, "list-1", {
            title: "Second done",
            completed: true,
            completedAt: "2026-06-01T13:00:00.000Z",
          }),
          makeTask("t3", USER, "list-1", { title: "Still active", order: 2 }),
        ],
      }),
      { replace: false },
    );

    renderTaskListView();

    await screen.findByText("2 completed");
    const expander = screen.getByText("2 completed").closest("details") as HTMLDetailsElement;
    // Collapsed by default — the User opens it deliberately.
    expect(expander.open).toBe(false);

    fireEvent.click(screen.getByText("2 completed"));
    expect(expander.open).toBe(true);
    const completedNames = within(expander)
      .getAllByRole("checkbox")
      .map((box) => box.getAttribute("aria-label"));
    expect(completedNames).toEqual(['Mark "Second done" not done', 'Mark "First done" not done']);

    // The still-active Task never moved into the expander.
    expect(screen.getByRole("checkbox", { name: 'Mark "Still active" done' })).toBeDefined();
  });

  it("clicking a row's title expands it into an editor, where renaming patches the Task (#253)", async () => {
    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk" })] }),
      {
        replace: false,
      },
    );

    renderTaskListView();
    fireEvent.click(await screen.findByRole("button", { name: "Buy milk" }));
    const input = await screen.findByDisplayValue("Buy milk");
    fireEvent.change(input, { target: { value: "Buy oat milk" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      expect((await readTask("t1"))?.title).toBe("Buy oat milk");
    });
  });

  it("deleting a row from its expanded editor soft-deletes it, raises an Undo toast, and Undo restores it (#257, moved into the editor by #253)", async () => {
    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk" })] }),
      {
        replace: false,
      },
    );

    renderTaskListView();
    fireEvent.click(await screen.findByRole("button", { name: "Buy milk" }));
    await screen.findByDisplayValue("Buy milk");
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(async () => {
      expect((await readTask("t1"))?.deletedAt).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Buy milk" })).toBeNull();
    });

    const undoButton = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undoButton);

    await waitFor(async () => {
      expect((await readTask("t1"))?.deletedAt).toBeNull();
    });
    expect(await screen.findByRole("button", { name: "Buy milk" })).toBeDefined();
  });

  it("a Task created from a second Client appears without a reload (#252: round-trips to a second Client)", async () => {
    renderTaskListView();
    expect(screen.queryByText("Buy milk")).toBeNull();

    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk" })] }),
      {
        replace: false,
      },
    );

    expect(await screen.findByRole("button", { name: "Buy milk" })).toBeDefined();
  });

  it("clicking a row's checkbox never expands it (#253)", async () => {
    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk" })] }),
      { replace: false },
    );

    renderTaskListView();
    fireEvent.click(await screen.findByRole("checkbox", { name: 'Mark "Buy milk" done' }));

    expect(screen.queryByLabelText("Task title")).toBeNull();
  });

  it("only one row is expanded at a time — expanding a second collapses the first (#253)", async () => {
    await applyTaskDelta(
      delta({
        created: [
          makeTask("t1", USER, "list-1", { title: "Buy milk", order: 0 }),
          makeTask("t2", USER, "list-1", { title: "Walk the dog", order: 1 }),
        ],
      }),
      { replace: false },
    );

    renderTaskListView();
    fireEvent.click(await screen.findByRole("button", { name: "Buy milk" }));
    await screen.findByDisplayValue("Buy milk");

    fireEvent.click(screen.getByRole("button", { name: "Walk the dog" }));

    await screen.findByDisplayValue("Walk the dog");
    expect(screen.queryByDisplayValue("Buy milk")).toBeNull();
  });

  it("clicking the expanded row's collapse control closes it back to the summary row (#253)", async () => {
    await applyTaskDelta(
      delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy milk" })] }),
      { replace: false },
    );

    renderTaskListView();
    fireEvent.click(await screen.findByRole("button", { name: "Buy milk" }));
    await screen.findByDisplayValue("Buy milk");

    fireEvent.click(screen.getByRole("button", { name: 'Collapse "Buy milk"' }));

    expect(screen.queryByLabelText("Task title")).toBeNull();
    expect(screen.getByRole("button", { name: "Buy milk" })).toBeDefined();
  });
});

describe("Sections and manual order (#255)", () => {
  it("a List with only its default Section shows no Section chrome — no heading, no add-section affordance in the row flow", async () => {
    const listWithOneSection = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [{ id: "sec-1", name: "Backlog" }],
    });
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", sectionId: "sec-1" })],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: listWithOneSection });
    await screen.findByRole("button", { name: "Buy milk" });

    expect(screen.queryByText("Backlog")).toBeNull();
    expect(screen.queryByRole("button", { name: 'Rename "Backlog"' })).toBeNull();
    // The header's own control is the only "Add section" anywhere — never
    // in the row flow below the two-Section threshold.
    expect(screen.getAllByRole("button", { name: "Add section" })).toHaveLength(1);
  });

  it("with two Sections, headings render with rename/delete, and 'Add section' moves into the row flow", async () => {
    const listWithSections = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [
        { id: "sec-1", name: "Backlog" },
        { id: "sec-2", name: "Done soon" },
      ],
    });

    renderTaskListView({ taskList: listWithSections });

    expect(await screen.findByText("Backlog")).toBeDefined();
    expect(screen.getByText("Done soon")).toBeDefined();
    expect(screen.getByRole("button", { name: 'Rename "Backlog"' })).toBeDefined();
    expect(screen.getByRole("button", { name: 'Delete "Backlog"' })).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Add section" })).toHaveLength(1);
  });

  it("the header's 'Add section' control creates the List's first Section", async () => {
    await applyTaskListDelta(delta({ created: [LIST] }), { replace: false });
    renderTaskListView();

    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    const input = screen.getByLabelText("New Section name");
    fireEvent.change(input, { target: { value: "Backlog" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.map((section) => section.name)).toEqual(["Backlog"]);
    });
  });

  it("renames a Section in place from its group heading", async () => {
    const listWithSections = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [
        { id: "sec-1", name: "Backlog" },
        { id: "sec-2", name: "Done soon" },
      ],
    });
    await applyTaskListDelta(delta({ created: [listWithSections] }), { replace: false });
    renderTaskListView({ taskList: listWithSections });
    await screen.findByText("Backlog");

    fireEvent.click(screen.getByRole("button", { name: 'Rename "Backlog"' }));
    const input = screen.getByLabelText('Rename "Backlog"');
    fireEvent.change(input, { target: { value: "Errands" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.find((section) => section.id === "sec-1")?.name).toBe("Errands");
    });
  });

  it("deleting a Section moves its Tasks to the List's first Section, raises Undo, and Undo restores the Section with its Tasks", async () => {
    const listWithSections = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [
        { id: "sec-1", name: "Backlog" },
        { id: "sec-2", name: "Done soon" },
      ],
    });
    await applyTaskListDelta(delta({ created: [listWithSections] }), { replace: false });
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", sectionId: "sec-2" })],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: listWithSections });
    await screen.findByText("Done soon");

    fireEvent.click(screen.getByRole("button", { name: 'Delete "Done soon"' }));

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.map((section) => section.id)).toEqual(["sec-1"]);
      expect((await readTask("t1"))?.sectionId).toBe("sec-1");
    });

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.map((section) => section.id)).toEqual(["sec-1", "sec-2"]);
      expect((await readTask("t1"))?.sectionId).toBe("sec-2");
    });
  });

  it("dragging a row reorders it within its Section, persisting a synced sort key", async () => {
    await applyTaskDelta(
      delta({
        created: [
          makeTask("t1", USER, "list-1", { title: "A", order: 0 }),
          makeTask("t2", USER, "list-1", { title: "B", order: 1 }),
          makeTask("t3", USER, "list-1", { title: "C", order: 2 }),
        ],
      }),
      { replace: false },
    );

    renderTaskListView();
    const rowC = (await screen.findByRole("button", { name: "C" })).closest("li") as HTMLLIElement;
    const rowA = (await screen.findByRole("button", { name: "A" })).closest("li") as HTMLLIElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(rowC, { dataTransfer });
    fireEvent.drop(rowA, { dataTransfer });

    await waitFor(async () => {
      const tasks = await readTasks("list-1");
      expect(tasks.map((task) => task.title)).toEqual(["C", "A", "B"]);
    });
  });

  it("dragging a row onto another Section's heading moves it there", async () => {
    const listWithSections = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [
        { id: "sec-1", name: "Backlog" },
        { id: "sec-2", name: "Done soon" },
      ],
    });
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", sectionId: "sec-1" })],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: listWithSections });
    const row = (await screen.findByRole("button", { name: "Buy milk" })).closest(
      "li",
    ) as HTMLLIElement;
    const targetHeading = screen
      .getByText("Done soon")
      .closest(".tasks-group-heading-row") as HTMLElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.drop(targetHeading, { dataTransfer });

    await waitFor(async () => {
      expect((await readTask("t1"))?.sectionId).toBe("sec-2");
    });
  });

  it("dragging a Section heading onto another reorders the List's Sections", async () => {
    const listWithSections = makeTaskList("list-1", USER, {
      name: "Groceries",
      sections: [
        { id: "sec-1", name: "Backlog" },
        { id: "sec-2", name: "Done soon" },
      ],
    });
    await applyTaskListDelta(delta({ created: [listWithSections] }), { replace: false });
    renderTaskListView({ taskList: listWithSections });
    const headingA = screen.getByText("Backlog").closest(".tasks-group-heading-row") as HTMLElement;
    const headingB = screen
      .getByText("Done soon")
      .closest(".tasks-group-heading-row") as HTMLElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(headingB, { dataTransfer });
    fireEvent.drop(headingA, { dataTransfer });

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.map((section) => section.id)).toEqual(["sec-2", "sec-1"]);
    });
  });
});

describe("Board mode and swimlanes (#256)", () => {
  const LIST_WITH_SECTIONS = makeTaskList("list-1", USER, {
    name: "Groceries",
    sections: [
      { id: "sec-1", name: "Backlog" },
      { id: "sec-2", name: "Doing" },
    ],
  });

  function switchToBoard() {
    fireEvent.change(screen.getByLabelText("View as"), { target: { value: "board" } });
  }

  it("the header select switches to Board mode, rendering the List's Sections as columns plus a fixed Done column, and the choice persists across a remount", async () => {
    const { unmount } = renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    expect((screen.getByLabelText("View as") as HTMLSelectElement).value).toBe("list");

    switchToBoard();

    expect(await screen.findByRole("region", { name: "Backlog column" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Doing column" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Done column" })).toBeDefined();

    unmount();
    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    expect(await screen.findByRole("region", { name: "Backlog column" })).toBeDefined();
    expect((screen.getByLabelText("View as") as HTMLSelectElement).value).toBe("board");
  });

  it("dragging a card between columns changes its Section", async () => {
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", sectionId: "sec-1" })],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    switchToBoard();
    const card = (await screen.findByRole("button", { name: "Buy milk" })).closest(
      "li",
    ) as HTMLLIElement;
    const doingColumn = screen.getByRole("region", { name: "Doing column" });

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(doingColumn, { dataTransfer });

    await waitFor(async () => {
      expect((await readTask("t1"))?.sectionId).toBe("sec-2");
    });
  });

  it("dragging a card within a column reorders it, persisting a synced sort key", async () => {
    await applyTaskDelta(
      delta({
        created: [
          makeTask("t1", USER, "list-1", { title: "A", sectionId: "sec-1", order: 0 }),
          makeTask("t2", USER, "list-1", { title: "B", sectionId: "sec-1", order: 1 }),
        ],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    switchToBoard();
    const cardB = (await screen.findByRole("button", { name: "B" })).closest("li") as HTMLLIElement;
    const cardA = (await screen.findByRole("button", { name: "A" })).closest("li") as HTMLLIElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(cardB, { dataTransfer });
    fireEvent.drop(cardA, { dataTransfer });

    await waitFor(async () => {
      const tasks = await readTasks("list-1");
      expect(tasks.map((task) => task.title)).toEqual(["B", "A"]);
    });
  });

  it("dragging a card onto Done completes it with the same Undo toast the checkbox gives, and dragging it back off Done uncompletes it into that column's Section", async () => {
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", sectionId: "sec-1" })],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    switchToBoard();
    const card = (await screen.findByRole("button", { name: "Buy milk" })).closest(
      "li",
    ) as HTMLLIElement;
    const doneColumn = screen.getByRole("region", { name: "Done column" });

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(doneColumn, { dataTransfer });

    await waitFor(async () => {
      expect((await readTask("t1"))?.completed).toBe(true);
    });
    expect(await screen.findByRole("button", { name: "Undo" })).toBeDefined();

    const doneCard = (await screen.findByRole("button", { name: "Buy milk" })).closest(
      "li",
    ) as HTMLLIElement;
    const doingColumn = screen.getByRole("region", { name: "Doing column" });
    const secondDrag = makeDataTransfer();
    fireEvent.dragStart(doneCard, { dataTransfer: secondDrag });
    fireEvent.drop(doingColumn, { dataTransfer: secondDrag });

    await waitFor(async () => {
      const task = await readTask("t1");
      expect(task?.completed).toBe(false);
      expect(task?.sectionId).toBe("sec-2");
    });
  });

  it("every Board move is also on the card's own menu — expanding a card opens the same TaskEditor a list row does", async () => {
    await applyTaskListDelta(delta({ created: [LIST_WITH_SECTIONS] }), { replace: false });
    await applyTaskDelta(
      delta({
        created: [makeTask("t1", USER, "list-1", { title: "Buy milk", sectionId: "sec-1" })],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    switchToBoard();
    fireEvent.click(await screen.findByRole("button", { name: "Buy milk" }));

    await screen.findByDisplayValue("Buy milk");
    await waitFor(() => {
      expect((screen.getByLabelText("Section") as HTMLSelectElement).value).toBe("sec-1");
    });
    expect(screen.getByRole("checkbox", { name: 'Mark "Buy milk" done' })).toBeDefined();
  });

  it("the column header's 'Add section' control creates the List's first Section — the same store intent List mode's own header control fires", async () => {
    const emptyList = makeTaskList("list-1", USER, { name: "Groceries", sections: [] });
    await applyTaskListDelta(delta({ created: [emptyList] }), { replace: false });

    renderTaskListView({ taskList: emptyList });
    switchToBoard();

    fireEvent.click(await screen.findByRole("button", { name: "Add section" }));
    const addInput = screen.getByLabelText("New Section name");
    fireEvent.change(addInput, { target: { value: "Backlog" } });
    fireEvent.keyDown(addInput, { key: "Enter" });

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.map((section) => section.name)).toEqual(["Backlog"]);
    });
  });

  it("renames and deletes a Section in place from its column header, the same intents List mode's group heading fires", async () => {
    await applyTaskListDelta(delta({ created: [LIST_WITH_SECTIONS] }), { replace: false });
    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    switchToBoard();
    await screen.findByRole("region", { name: "Backlog column" });

    fireEvent.click(screen.getByRole("button", { name: 'Rename "Backlog"' }));
    const renameInput = screen.getByLabelText('Rename "Backlog"');
    fireEvent.change(renameInput, { target: { value: "Errands" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.find((section) => section.id === "sec-1")?.name).toBe("Errands");
    });

    fireEvent.click(screen.getByRole("button", { name: 'Delete "Doing"' }));

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.map((section) => section.id)).toEqual(["sec-1"]);
    });
  });

  it("dragging a column header onto another reorders the List's Sections", async () => {
    await applyTaskListDelta(delta({ created: [LIST_WITH_SECTIONS] }), { replace: false });
    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    switchToBoard();
    await screen.findByRole("region", { name: "Backlog column" });
    const headingA = screen
      .getByText("Backlog")
      .closest(".task-board-column-header") as HTMLElement;
    const headingB = screen.getByText("Doing").closest(".task-board-column-header") as HTMLElement;

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(headingB, { dataTransfer });
    fireEvent.drop(headingA, { dataTransfer });

    await waitFor(async () => {
      const list = await readTaskList("list-1");
      expect(list?.sections.map((section) => section.id)).toEqual(["sec-2", "sec-1"]);
    });
  });

  it("swimlane grouping cuts the Board into rows by due bucket, none as the default", async () => {
    await applyTaskDelta(
      delta({
        created: [
          makeTask("t1", USER, "list-1", {
            title: "Overdue one",
            sectionId: "sec-1",
            dueDate: "2000-01-01T00:00:00.000Z",
          }),
        ],
      }),
      { replace: false },
    );

    renderTaskListView({ taskList: LIST_WITH_SECTIONS });
    switchToBoard();
    expect(screen.queryByText("Overdue")).toBeNull();

    fireEvent.change(screen.getByLabelText("Group Board rows by"), {
      target: { value: "dueBucket" },
    });

    expect(await screen.findByText("Overdue")).toBeDefined();
  });
});
