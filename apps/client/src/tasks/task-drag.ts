import type { Task } from "@mail/shared";

/**
 * `dataTransfer` MIME types the Tasks App's own native drag (#255, no drag
 * library — "matching what the Calendar prototype already does for Task
 * chips") tags its two kinds of payload with, so a card dropped on a heading
 * and a heading dropped on another heading never get parsed as each other.
 * Shared by `TaskListView.tsx`'s row drag and `TaskBoardView.tsx`'s card/column
 * drag (#256) — the same two payload kinds, just read by a second layout.
 */
export const TASK_DRAG_TYPE = "application/x-mail-task-id";
export const SECTION_DRAG_TYPE = "application/x-mail-section-id";

/**
 * A synced sort key (#255) for inserting at `index` among `siblings` — the
 * midpoint between its new neighbors' own `order`, so a drop never has to
 * rewrite any Task's `order` but the one that moved. Falls outside either
 * end when there's no neighbor there yet, the same distance
 * `TaskQuickAdd`'s own `Date.now()` scale already sits on.
 *
 * Shared by `TaskListView.tsx`'s row drag and `TaskBoardView.tsx`'s card drag
 * (#256) — a Board column (or one swimlane row's own slice of it) is just one
 * more `siblings` array, not a different arithmetic.
 */
export function midpointOrder(siblings: readonly Task[], index: number): number {
  const before = siblings[index - 1]?.order;
  const after = siblings[index]?.order;
  if (before === undefined && after === undefined) return Date.now();
  if (before === undefined) return (after as number) - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}
