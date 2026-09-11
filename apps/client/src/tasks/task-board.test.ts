import { describe, expect, it } from "vitest";
import { makeLabel, makeTask, makeTaskList } from "../test-support/mail-fixtures.js";
import {
  BOARD_DONE_COLUMN_ID,
  BOARD_UNSECTIONED_COLUMN_ID,
  buildBoardColumns,
  buildSwimlaneRows,
  tasksForColumn,
} from "./task-board.js";
import { dateOnlyToWireDueDate } from "./task-due.js";

const USER = "user-1";
const LIST = "list-1";

describe("buildBoardColumns (#256)", () => {
  it("renders the List's own Sections in order, plus a fixed Done column last", () => {
    const list = makeTaskList(LIST, USER, {
      sections: [
        { id: "sec-1", name: "Backlog" },
        { id: "sec-2", name: "Doing" },
      ],
    });
    const columns = buildBoardColumns(list, []);
    expect(columns.map((column) => column.id)).toEqual(["sec-1", "sec-2", BOARD_DONE_COLUMN_ID]);
    expect(columns.at(-1)).toMatchObject({ isDone: true, sectionId: null });
  });

  it("always shows a 'No section' column for a zero-Section List — Board has nowhere else to put an active Task", () => {
    const list = makeTaskList(LIST, USER, { sections: [] });
    const columns = buildBoardColumns(list, []);
    expect(columns.map((column) => column.id)).toEqual([
      BOARD_UNSECTIONED_COLUMN_ID,
      BOARD_DONE_COLUMN_ID,
    ]);
  });

  it("adds a 'No section' column only when a Sectioned List actually has an unsectioned active Task", () => {
    const list = makeTaskList(LIST, USER, { sections: [{ id: "sec-1", name: "Backlog" }] });
    const tidy = buildBoardColumns(list, [makeTask("t1", USER, LIST, { sectionId: "sec-1" })]);
    expect(tidy.map((column) => column.id)).toEqual(["sec-1", BOARD_DONE_COLUMN_ID]);

    const withStray = buildBoardColumns(list, [makeTask("t1", USER, LIST, { sectionId: null })]);
    expect(withStray.map((column) => column.id)).toEqual([
      "sec-1",
      BOARD_UNSECTIONED_COLUMN_ID,
      BOARD_DONE_COLUMN_ID,
    ]);
  });

  it("a completed Task naming no Section never forces the 'No section' column open on its own — Done already holds it", () => {
    const list = makeTaskList(LIST, USER, { sections: [{ id: "sec-1", name: "Backlog" }] });
    const columns = buildBoardColumns(list, [
      makeTask("t1", USER, LIST, { sectionId: null, completed: true }),
    ]);
    expect(columns.map((column) => column.id)).toEqual(["sec-1", BOARD_DONE_COLUMN_ID]);
  });
});

describe("tasksForColumn", () => {
  const list = makeTaskList(LIST, USER, { sections: [{ id: "sec-1", name: "Backlog" }] });
  const columns = buildBoardColumns(list, []);
  const knownSectionIds = new Set(list.sections.map((section) => section.id));
  const namedColumn = columns[0] as (typeof columns)[number];
  const doneColumn = columns.find((column) => column.isDone) as (typeof columns)[number];

  it("pools a named column's own active Tasks in manual order", () => {
    const tasks = [
      makeTask("t2", USER, LIST, { sectionId: "sec-1", order: 2 }),
      makeTask("t1", USER, LIST, { sectionId: "sec-1", order: 1 }),
    ];
    expect(tasksForColumn(tasks, namedColumn, knownSectionIds).map((task) => task.id)).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("never leaks a completed Task into a named column", () => {
    const tasks = [makeTask("t1", USER, LIST, { sectionId: "sec-1", completed: true })];
    expect(tasksForColumn(tasks, namedColumn, knownSectionIds)).toEqual([]);
  });

  it("pools Done newest-completedAt-first, regardless of Section", () => {
    const tasks = [
      makeTask("t1", USER, LIST, {
        sectionId: "sec-1",
        completed: true,
        completedAt: "2026-06-01T12:00:00.000Z",
      }),
      makeTask("t2", USER, LIST, {
        sectionId: null,
        completed: true,
        completedAt: "2026-06-02T12:00:00.000Z",
      }),
    ];
    expect(tasksForColumn(tasks, doneColumn, knownSectionIds).map((task) => task.id)).toEqual([
      "t2",
      "t1",
    ]);
  });
});

describe("buildSwimlaneRows (#256)", () => {
  it("'none' puts everything in one unheaded row", () => {
    const tasks = [makeTask("t1", USER, LIST), makeTask("t2", USER, LIST)];
    const rows = buildSwimlaneRows("none", tasks, []);
    expect(rows).toEqual([{ key: "all", heading: null, tasks }]);
  });

  it("'dueBucket' groups by due bucket, in fixed urgency order, dropping empty buckets", () => {
    const now = new Date(2026, 5, 15, 9, 0, 0);
    const overdue = makeTask("t1", USER, LIST, { dueDate: dateOnlyToWireDueDate("2026-06-10") });
    const noDate = makeTask("t2", USER, LIST, { dueDate: null });
    const rows = buildSwimlaneRows("dueBucket", [overdue, noDate], [], now);
    expect(rows.map((row) => row.heading)).toEqual(["Overdue", "No date"]);
    expect(rows[0]?.tasks).toEqual([overdue]);
    expect(rows[1]?.tasks).toEqual([noDate]);
  });

  it("'label' groups by a Task's alphabetically-first Label name, with a trailing 'No label' row", () => {
    const labels = [makeLabel("user-1:Work", USER, { name: "Work" })];
    const labeled = makeTask("t1", USER, LIST, { labelIds: ["user-1:Work"] });
    const unlabeled = makeTask("t2", USER, LIST, { labelIds: [] });
    const rows = buildSwimlaneRows("label", [labeled, unlabeled], labels);
    expect(rows.map((row) => row.heading)).toEqual(["Work", "No label"]);
  });

  it("'label' picks one row per Task even with several Labels — never duplicates a card", () => {
    const labels = [
      makeLabel("l-work", USER, { name: "Work" }),
      makeLabel("l-home", USER, { name: "Home" }),
    ];
    const task = makeTask("t1", USER, LIST, { labelIds: ["l-work", "l-home"] });
    const rows = buildSwimlaneRows("label", [task], labels);
    // "Home" sorts before "Work" — the alphabetically-first Label wins.
    expect(rows).toEqual([{ key: "Home", heading: "Home", tasks: [task] }]);
  });
});
