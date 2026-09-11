import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import type { CachedThread } from "../store/index.js";
import { useTaskLists } from "../store/index.js";
import { addLocalDays, dateOnlyToWireDueDate, localDateInputValue } from "../tasks/task-due.js";
import "./add-to-tasks-sheet.css";

/** One Due choice the sheet offers — the ticket's own list, "Today, Tomorrow, Next week, Pick a date, None". */
type DuePreset = "today" | "tomorrow" | "nextWeek" | "pick" | "none";

const DUE_PRESETS: { key: DuePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "nextWeek", label: "Next week" },
  { key: "pick", label: "Pick a date" },
  { key: "none", label: "None" },
];

/** What either confirm hands back to the caller — everything `store/tasks.ts#createTaskFromThreadLink` needs beyond the Thread itself. */
export interface AddToTasksResult {
  taskListId: string;
  title: string;
  /** Already wire-encoded (`task-due.ts#dateOnlyToWireDueDate`), or `null` for "None"/an empty "Pick a date". */
  dueDate: string | null;
}

/**
 * "Add to Tasks" (#258): the Reader's own sheet, opened by the registry's
 * `add-to-tasks` action (`actions/registry.ts`) through
 * `mail/MailSection.tsx`'s own `onAddToTasks` handler — unlike "Add to
 * Notes", which creates the Note at once, a Task's Due is worth a sheet of
 * its own since the Reader has no other place to ask for one.
 *
 * Holds its own draft (title, Task List, Due preset) and nothing else —
 * neither confirm writes anything itself; both just hand the draft back to
 * the caller (`onAdd`/`onAddAndMarkDone`), which does the actual Task
 * creation, toast and Undo (`MailSection.tsx`'s own
 * `onAddToTasksConfirm`/`onAddToTasksConfirmAndDone`). The draft reseeds
 * fresh from `thread` every time the sheet opens (`open` flipping to
 * `true`), so a stale title or List from the last Thread never survives
 * into the next.
 */
export function AddToTasksSheet({
  open,
  thread,
  defaultTaskListId,
  onOpenChange,
  onAdd,
  onAddAndMarkDone,
}: {
  open: boolean;
  /** The Thread this sheet is about — `null` once it's closed again, same "the row/reader owns the open Thread" shape every other Reader surface takes. */
  thread: CachedThread | null;
  /** The User's default Task List (`TaskList.isDefault`) — seeds the picker; `null` while Task Lists haven't loaded yet, which leaves the picker on the first List in the list instead. */
  defaultTaskListId: string | null;
  onOpenChange: (open: boolean) => void;
  onAdd: (result: AddToTasksResult) => void;
  onAddAndMarkDone: (result: AddToTasksResult) => void;
}) {
  const taskLists = useTaskLists() ?? [];
  const [title, setTitle] = useState("");
  const [taskListId, setTaskListId] = useState("");
  const [duePreset, setDuePreset] = useState<DuePreset>("none");
  const [customDate, setCustomDate] = useState("");

  // Seeds a fresh draft every time the sheet opens — never carries over what
  // the last Thread's sheet left behind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `taskLists`/its first id deliberately excluded — only the moment the sheet opens should reseed the List picker, not every live-query tick while it's sitting open (a Task List renamed or reordered elsewhere mid-pick shouldn't reset the User's own selection).
  useEffect(() => {
    if (!open) return;
    setTitle(thread?.subject || "(no subject)");
    setTaskListId(defaultTaskListId ?? taskLists[0]?.id ?? "");
    setDuePreset("none");
    setCustomDate("");
  }, [open, thread, defaultTaskListId]);

  function resolveDueDate(): string | null {
    const now = new Date();
    switch (duePreset) {
      case "today":
        return dateOnlyToWireDueDate(localDateInputValue(now));
      case "tomorrow":
        return dateOnlyToWireDueDate(addLocalDays(now, 1));
      case "nextWeek":
        return dateOnlyToWireDueDate(addLocalDays(now, 7));
      case "pick":
        return customDate ? dateOnlyToWireDueDate(customDate) : null;
      case "none":
        return null;
    }
  }

  function buildResult(): AddToTasksResult {
    return {
      taskListId,
      title: title.trim() || thread?.subject || "(no subject)",
      dueDate: resolveDueDate(),
    };
  }

  const canSubmit = thread !== null && taskListId !== "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="add-to-tasks-sheet">
        <SheetHeader>
          <SheetTitle>Add to Tasks</SheetTitle>
          <SheetDescription>Create a Task from this Thread.</SheetDescription>
        </SheetHeader>
        <div className="add-to-tasks-fields">
          <label className="add-to-tasks-field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label="Task title"
            />
          </label>
          <label className="add-to-tasks-field">
            <span>Task List</span>
            <select
              value={taskListId}
              onChange={(event) => setTaskListId(event.target.value)}
              aria-label="Task List"
            >
              {taskLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="add-to-tasks-due">
            <legend>Due</legend>
            <div className="add-to-tasks-due-options">
              {DUE_PRESETS.map((preset) => (
                <label key={preset.key} className="add-to-tasks-due-option">
                  <input
                    type="radio"
                    name="add-to-tasks-due"
                    checked={duePreset === preset.key}
                    onChange={() => setDuePreset(preset.key)}
                  />
                  {preset.label}
                </label>
              ))}
            </div>
            {duePreset === "pick" ? (
              <input
                type="date"
                aria-label="Due date"
                value={customDate}
                onChange={(event) => setCustomDate(event.target.value)}
              />
            ) : null}
          </fieldset>
        </div>
        <SheetFooter className="add-to-tasks-actions">
          <button
            type="button"
            className="add-to-tasks-add"
            disabled={!canSubmit}
            onClick={() => {
              onAdd(buildResult());
              onOpenChange(false);
            }}
          >
            Add
          </button>
          <button
            type="button"
            className="add-to-tasks-add-done"
            disabled={!canSubmit}
            onClick={() => {
              onAddAndMarkDone(buildResult());
              onOpenChange(false);
            }}
          >
            Add and mark Done
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
