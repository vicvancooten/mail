/**
 * Whether due Tasks show on the Calendar's grid (#260) — a **Device
 * Preference**, `calendar-visibility.ts`'s own reasoning applied to the
 * slide-over's single "Tasks" row rather than a per-Calendar one: which
 * overlay you're looking at right now means something different on each
 * device, so this never syncs and never rides `enqueueUserMutation`. Stored
 * as a plain boolean, not a hidden-set — there is exactly one row to
 * show/hide, not one per Task List (the ticket's own "Tasks are not a
 * Calendar and never get one's colour or a colour picker").
 *
 * Same `useSyncExternalStore` shape as `calendar-visibility.ts` — a toggle
 * from `CalendarSlideOver.tsx` reaches every mounted grid the same instant.
 */
import { useSyncExternalStore } from "react";

const SHOW_TASKS_KEY = "calendar.devicePref.showTasksOnGrid";

function readStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(SHOW_TASKS_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    globalThis.localStorage?.setItem(SHOW_TASKS_KEY, value);
  } catch {
    // Best-effort; a lost preference just falls back to "Tasks shown".
  }
}

/** Defaults to shown — a User who has never touched the toggle sees due Tasks on the grid. */
export function readShowTasksOnGrid(): boolean {
  return readStorage() !== "false";
}

const listeners = new Set<() => void>();

export function writeShowTasksOnGrid(show: boolean): void {
  writeStorage(String(show));
  for (const listener of listeners) listener();
}

function subscribeShowTasksOnGrid(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive pair for the "Tasks" row's show/hide toggle. */
export function useShowTasksOnGrid(): [boolean, (show: boolean) => void] {
  const show = useSyncExternalStore(subscribeShowTasksOnGrid, readShowTasksOnGrid, () => true);
  return [show, writeShowTasksOnGrid];
}
