import { announceUndoableAction } from "../mail/undo-toast.js";
import { readTask, setTaskDueDate } from "../store/tasks.js";
import { dateOnlyToWireDueDate } from "../tasks/task-due.js";
import type { CivilDate } from "./calendar-dates.js";
import { dayKey } from "./calendar-dates.js";

/**
 * Drops a dragged Task chip (#261) onto `day`: the same field-patch intent
 * the Tasks App's own Due control fires (`store/tasks.ts#setTaskDueDate`),
 * which only ever patches `dueDate` — the dragged Task's `dueTime` is left
 * exactly as it was, "preserves its due time" (this ticket's own acceptance
 * line). Undoable from the same coalescing toast every other Task action
 * raises (`mail/undo-toast.ts`'s own `"taskReschedule"` kind).
 *
 * A no-op drop onto the day the Task is already due on changes nothing and
 * raises no toast — there is nothing to undo.
 */
export async function rescheduleTaskTo(taskId: string, day: CivilDate): Promise<void> {
  const task = await readTask(taskId);
  if (!task) return;
  const previousDueDate = task.dueDate;
  const nextDueDate = dateOnlyToWireDueDate(dayKey(day));
  if (previousDueDate === nextDueDate) return;
  void setTaskDueDate(taskId, nextDueDate);
  announceUndoableAction("taskReschedule", () => void setTaskDueDate(taskId, previousDueDate));
}
