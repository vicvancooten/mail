import { describe, expect, it } from "vitest";
import { makeTask } from "../test-support/mail-fixtures.js";
import { bucketTasksByDay } from "./calendar-task-occurrences.js";

const USER = "u1";
const LIST = "list-1";

describe("calendar-task-occurrences (#260)", () => {
  it("buckets a due Task onto its own day key", () => {
    const task = makeTask("t1", USER, LIST, { dueDate: "2026-09-08T00:00:00.000Z" });
    const buckets = bucketTasksByDay([task]);
    expect(buckets.get("2026-09-08")).toEqual([task]);
  });

  it("never buckets a Task with no due date", () => {
    const task = makeTask("t1", USER, LIST, { dueDate: null });
    expect(bucketTasksByDay([task]).size).toBe(0);
  });

  it("drops a completed Task — it has already left the grid", () => {
    const task = makeTask("t1", USER, LIST, {
      dueDate: "2026-09-08T00:00:00.000Z",
      completed: true,
      completedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(bucketTasksByDay([task]).size).toBe(0);
  });

  it("sorts a day's Tasks by due time then title, no-time Tasks first", () => {
    const noTime = makeTask("t-no-time", USER, LIST, {
      title: "Zebra",
      dueDate: "2026-09-08T00:00:00.000Z",
      dueTime: null,
    });
    const early = makeTask("t-early", USER, LIST, {
      title: "Early",
      dueDate: "2026-09-08T00:00:00.000Z",
      dueTime: "09:00",
    });
    const late = makeTask("t-late", USER, LIST, {
      title: "Late",
      dueDate: "2026-09-08T00:00:00.000Z",
      dueTime: "17:00",
    });
    const buckets = bucketTasksByDay([late, early, noTime]);
    expect(buckets.get("2026-09-08")?.map((t) => t.id)).toEqual(["t-no-time", "t-early", "t-late"]);
  });

  it("a multi-day-agnostic Task never spans more than its own single due day", () => {
    const task = makeTask("t1", USER, LIST, { dueDate: "2026-09-08T00:00:00.000Z" });
    const buckets = bucketTasksByDay([task]);
    expect([...buckets.keys()]).toEqual(["2026-09-08"]);
  });
});
