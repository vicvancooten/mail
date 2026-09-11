import { describe, expect, it } from "vitest";
import { defaultTaskListId, taskListSchema, taskSchema, taskSectionSchema } from "./tasks.js";

const VALID_SECTION = { id: "section-1", name: "Today" };

const VALID_TASK_LIST = {
  id: "list-1",
  userId: "user-1",
  name: "Tasks",
  sections: [VALID_SECTION],
  isDefault: true,
  order: 0,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const VALID_TASK = {
  id: "task-1",
  userId: "user-1",
  taskListId: "list-1",
  sectionId: "section-1",
  title: "Buy milk",
  document: [],
  completed: false,
  completedAt: null,
  dueDate: null,
  dueTime: null,
  labelIds: [],
  threadLink: null,
  order: 0,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("taskSectionSchema", () => {
  it("accepts an {id, name} pair", () => {
    expect(taskSectionSchema.parse(VALID_SECTION)).toEqual(VALID_SECTION);
  });
});

describe("taskListSchema", () => {
  it("round-trips a valid Task List", () => {
    expect(taskListSchema.parse(VALID_TASK_LIST)).toEqual(VALID_TASK_LIST);
  });

  it("accepts an empty Sections array — a brand-new List has none", () => {
    expect(taskListSchema.parse({ ...VALID_TASK_LIST, sections: [] }).sections).toEqual([]);
  });
});

describe("taskSchema", () => {
  it("round-trips a valid Task", () => {
    expect(taskSchema.parse(VALID_TASK)).toEqual(VALID_TASK);
  });

  it("accepts a null sectionId — unsectioned in its List", () => {
    expect(taskSchema.parse({ ...VALID_TASK, sectionId: null }).sectionId).toBeNull();
  });

  it("accepts completed: true — completed Tasks replicate the same as any other", () => {
    expect(
      taskSchema.parse({ ...VALID_TASK, completed: true, completedAt: VALID_TASK.createdAt })
        .completed,
    ).toBe(true);
  });

  it("reuses noteDocumentSchema's own block shape for the body", () => {
    const document = [{ id: "b1", type: "paragraph", props: {}, content: [], children: [] }];
    expect(taskSchema.parse({ ...VALID_TASK, document }).document).toEqual(document);
  });

  it("accepts an 'HH:MM' dueTime alongside a dueDate", () => {
    expect(
      taskSchema.parse({
        ...VALID_TASK,
        dueDate: "2026-06-15T00:00:00.000Z",
        dueTime: "14:30",
      }).dueTime,
    ).toBe("14:30");
  });

  it("rejects a dueTime not shaped 'HH:MM'", () => {
    expect(() => taskSchema.parse({ ...VALID_TASK, dueTime: "2:30 PM" })).toThrow();
  });

  it("carries labelIds, the same membership shape a Note's own gives", () => {
    expect(taskSchema.parse({ ...VALID_TASK, labelIds: ["user-1:Work"] }).labelIds).toEqual([
      "user-1:Work",
    ]);
  });

  it("accepts a Thread Link field (#258) — the snapshot that drives the mail chip", () => {
    const threadLink = {
      threadId: "t1",
      subject: "Quarterly numbers",
      participants: "Ada Lovelace",
      date: "2026-06-25T09:00:00.000Z",
    };
    expect(taskSchema.parse({ ...VALID_TASK, threadLink }).threadLink).toEqual(threadLink);
  });
});

describe("defaultTaskListId", () => {
  it("is deterministic from the User alone — the same id every call derives", () => {
    expect(defaultTaskListId("user-1")).toBe(defaultTaskListId("user-1"));
  });

  it("differs per User", () => {
    expect(defaultTaskListId("user-1")).not.toBe(defaultTaskListId("user-2"));
  });
});
