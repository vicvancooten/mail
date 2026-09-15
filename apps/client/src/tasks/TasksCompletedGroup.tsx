import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The completed group (#322, replacing every `<details>`/`<summary>` the
 * three views — `TaskListView.tsx`, `TaskTodayView.tsx`,
 * `TaskUpcomingView.tsx` — each hand-rolled): Mail's own `.group-header`
 * idiom, one level down — a flush, ground-colored, collapsible band naming
 * a count rather than a full taper tier of its own (there is only ever one
 * of these per view, never a scale to rank). A real `<button>` with
 * `aria-expanded` rather than `<details>`/`<summary>`: `<details>` has no
 * exit animation hook and its own disclosure triangle can't be restyled
 * without `::-webkit-details-marker` hacks (`tasks.css`'s old rule this
 * replaces) — a button toggling a sibling list is the same interaction
 * with none of that.
 */
export function TasksCompletedGroup({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        className="tasks-completed-header"
        aria-expanded={open}
        onClick={() => onToggle(!open)}
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className="tasks-completed-chevron"
          data-open={open}
        />
        {/* One element, not a separate count node beside a text node: RTL's
            `getByText` (and any screen reader's own accessible name) reads
            only a node's own direct text children, so a `<span>` wrapping
            just the number would never match "N completed" as one string —
            `font-variant-numeric: tabular-nums` (`tasks.css`) reaches the
            digits inside this span without needing a second element around
            them. */}
        <span className="tasks-completed-count">{count} completed</span>
      </button>
      {open ? <ul className="task-list">{children}</ul> : null}
    </>
  );
}
