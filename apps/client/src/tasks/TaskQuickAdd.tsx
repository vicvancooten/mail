import { Plus } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";

/**
 * Quick add (#252): "an 'Add a task…' line at the top of the view; Enter
 * adds and keeps focus so several Tasks can be typed in a row." The input
 * is never blurred or unmounted on submit — `value` just resets to empty —
 * so "keeps focus" falls out of not doing anything to lose it, rather than
 * an explicit re-focus call.
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
 */
export function TaskQuickAdd({
  onAdd,
  ariaLabel = "Add a task",
  placeholder = "Add a task…",
}: {
  onAdd: (title: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
