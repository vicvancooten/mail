import { Plus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { registerTasksQuickAddFocus } from "./tasks-focus-registry.js";

/**
 * Quick add (#252): "a ghost row '+ Add a task' at the top of the list"
 * (R2/R3, `docs/design/polish-pass.md#Tasks`) — no border at rest, taking
 * `--color-field` only while focused (`tasks.css#.tasks-quick-add:focus-within`),
 * the same "chrome shows up only when it's in use" idiom the row's own
 * hover-revealed controls already carry. Enter adds and keeps focus so
 * several Tasks can be typed in a row." The input is never blurred or
 * unmounted on submit — `value` just resets to empty — so "keeps focus"
 * falls out of not doing anything to lose it, rather than an explicit
 * re-focus call.
 *
 * Deliberately just a plain text field with no parsing of its own value:
 * "No natural-language date parsing: 'buy milk tomorrow' is a Task called
 * 'buy milk tomorrow'" (the ticket's own words) — this component hands
 * `onAdd` the trimmed text verbatim, and there's nothing else here that
 * could turn part of it into a date even by accident.
 *
 * `ariaLabel`/`placeholder` default to a List's own plain "Add a task…" —
 * Upcoming (#254) overrides both per day group (`TaskUpcomingView.tsx`),
 * since a page can render several of these at once and each needs its own
 * accessible name.
 *
 * `registerFocus` (#322): opts this instance into
 * `tasks-focus-registry.ts` — "New task" (the header pill/Dock tile) then
 * focuses it directly instead of navigating. Only a List's own
 * (`TaskListView.tsx`) and Today's own (`TaskTodayView.tsx`) pass `true`:
 * Upcoming mounts one of these per day group, and there is no single one
 * of those that "the primary action" could mean, so it leaves the
 * registry alone (`TaskUpcomingView.tsx`'s own doc comment).
 */
export function TaskQuickAdd({
  onAdd,
  ariaLabel = "Add a task",
  placeholder = "Add a task…",
  registerFocus = false,
}: {
  onAdd: (title: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  registerFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `registerFocus` is read once — it names a role this instance plays for its whole lifetime (a call site never flips it mid-mount), not a value this effect should react to.
  useEffect(() => {
    if (!registerFocus) return;
    return registerTasksQuickAddFocus(() => inputRef.current?.focus());
  }, []);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onAdd(trimmed);
    setValue("");
    inputRef.current?.focus();
  }

  return (
    <form className="tasks-quick-add" onSubmit={handleSubmit}>
      <Plus size={14} aria-hidden="true" className="tasks-quick-add-icon" />
      <input
        ref={inputRef}
        type="text"
        className="tasks-quick-add-input"
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </form>
  );
}
