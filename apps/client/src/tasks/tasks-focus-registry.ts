/**
 * The Tasks main pane's own focus registry (#322, closing the TODO
 * `apps/primary-action.ts` left on #319): "New task" — the header's
 * `.btn-primary` and the phone Dock's trailing tile, both driven by
 * `usePrimaryAction` — no longer always navigates to `/tasks?view=today`.
 * It focuses the quick-add row already on screen when one is mounted, the
 * same "the primary action focuses the quick-add of the current view"
 * `docs/design/polish-pass.md#Tasks` asks for.
 *
 * A single module-level slot rather than a `Map`/Context: exactly one
 * quick-add ever needs to answer "New task" at a time — `TaskListView.tsx`
 * and `TaskTodayView.tsx` each mount exactly one and register it; Upcoming
 * (`TaskUpcomingView.tsx`) mounts one per day group and registers none
 * (`usePrimaryAction` never routes there, so nothing would ever call
 * `focusTasksQuickAdd` while it's the one on screen — see that file's own
 * doc comment). The last-mounted registration always wins, which is
 * correct here since List/Today's own quick-add is always alone.
 */

let focusCurrentQuickAdd: (() => void) | null = null;

/**
 * Called from `TaskQuickAdd`'s own mount effect — hands back the
 * unregister function an effect cleanup calls, so a view that unmounts (or
 * remounts, e.g. switching Lists) never leaves a stale focuser behind that
 * would silently do nothing (or worse, focus a detached input) on the next
 * "New task" press.
 */
export function registerTasksQuickAddFocus(focus: () => void): () => void {
  focusCurrentQuickAdd = focus;
  return () => {
    if (focusCurrentQuickAdd === focus) focusCurrentQuickAdd = null;
  };
}

/**
 * `usePrimaryAction`'s own "tasks" case calls this first. Returns whether a
 * quick-add was actually there to focus — `false` only when the Tasks App
 * isn't the one currently mounted (another App is on screen, or Upcoming
 * is), in which case the caller falls back to navigating to Today, same as
 * before this ticket.
 */
export function focusTasksQuickAdd(): boolean {
  if (!focusCurrentQuickAdd) return false;
  focusCurrentQuickAdd();
  return true;
}
