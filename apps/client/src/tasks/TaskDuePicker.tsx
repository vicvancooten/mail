import {
  addLocalDays,
  dateOnlyToWireDueDate,
  localDateInputValue,
  wireDueDateToDateInputValue,
} from "./task-due.js";

/**
 * The Due control's own popover (#253): presets first ("what the User picks
 * nine times out of ten," the ticket's own words), then a plain date picker
 * and an optional time — `mail/SnoozeMenu.tsx`'s own small-popover shape,
 * not shared with it directly since the two pick fundamentally different
 * things (a zone-less day plus a floating time vs. a real instant).
 *
 * No Save button, `TaskEditor.tsx`'s own posture: every preset, every date
 * change and every time change commits at once through `onSetDate`/
 * `onSetTime` — both already carry the wire encoding (`task-due.ts`), so the
 * caller only ever has to hand the result straight to `setTaskDueDate`/
 * `setTaskDueTime`. The time input is disabled with no `dueDate` set — "a
 * time is only settable once a date is set" (the ticket's own acceptance
 * line) — and clearing the date (the "No date" preset, or clearing the date
 * input by hand) always clears the time in the same breath, since a Task's
 * `dueTime` must never outlive its `dueDate` (`@mail/shared`'s `taskSchema`
 * own doc comment).
 */
export function TaskDuePicker({
  dueDate,
  dueTime,
  onSetDate,
  onSetTime,
}: {
  dueDate: string | null;
  dueTime: string | null;
  /** Already wire-encoded (`task-due.ts#dateOnlyToWireDueDate`), or `null` to clear both fields. */
  onSetDate: (dueDate: string | null) => void;
  /** A bare `"HH:MM"` from the time input, or `null` to clear it alone. */
  onSetTime: (dueTime: string | null) => void;
}) {
  const now = new Date();
  const dateInputValue = dueDate ? wireDueDateToDateInputValue(dueDate) : "";

  const presets: { label: string; date: string | null }[] = [
    { label: "Today", date: localDateInputValue(now) },
    { label: "Tomorrow", date: addLocalDays(now, 1) },
    { label: "Next week", date: addLocalDays(now, 7) },
    { label: "No date", date: null },
  ];

  return (
    <div className="task-due-picker" role="menu" aria-label="Due">
      <ul className="task-due-picker-presets">
        {presets.map((preset) => (
          <li key={preset.label}>
            <button
              type="button"
              role="menuitem"
              onClick={() => onSetDate(preset.date ? dateOnlyToWireDueDate(preset.date) : null)}
            >
              {preset.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="task-due-picker-custom">
        <input
          type="date"
          aria-label="Due date"
          value={dateInputValue}
          onChange={(event) =>
            onSetDate(event.target.value ? dateOnlyToWireDueDate(event.target.value) : null)
          }
        />
        <input
          type="time"
          aria-label="Due time"
          value={dueTime ?? ""}
          disabled={!dueDate}
          onChange={(event) => onSetTime(event.target.value || null)}
        />
      </div>
    </div>
  );
}
