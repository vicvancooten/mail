import type { Task } from "@mail/shared";
import { wireDueDateToDateInputValue } from "../tasks/task-due.js";

/**
 * Due Tasks on the Calendar's grid (#260): a Task with a `dueDate` buckets
 * onto exactly one day key — its own due day, in the same zone-less
 * `wireDueDateToDateInputValue` reading `task-due.ts#isOverdue` already uses
 * — never a range the way a multi-day all-day Event's `eventDayKeys` does
 * (ADR-0030: a Task is a deadline, one day, not a span). A Task with no
 * `dueDate` never appears here at all; a completed one drops out the moment
 * this reads it back, `useAllTasks`'s own live query re-running the instant
 * `completeTask`/`uncompleteTask` patches the row — no animate-out of its
 * own on the grid (`TaskListView.tsx`'s fade is that view's own chrome).
 *
 * Sorted within a day by due time then title — `store/tasks.ts#compareByDueTimeThenOrder`'s
 * own tie-break, swapping manual `order` for `title` since the grid has no
 * per-List manual ordering of its own to fall back to.
 */
export function bucketTasksByDay(tasks: readonly Task[]): Map<string, Task[]> {
  const byDay = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.completed || task.dueDate === null) continue;
    const key = wireDueDateToDateInputValue(task.dueDate);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(task);
    else byDay.set(key, [task]);
  }
  for (const bucket of byDay.values()) {
    bucket.sort((left, right) => {
      const timeCompare = (left.dueTime ?? "").localeCompare(right.dueTime ?? "");
      return timeCompare !== 0 ? timeCompare : left.title.localeCompare(right.title);
    });
  }
  return byDay;
}
