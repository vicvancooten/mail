import { useSyncExternalStore } from "react";

/**
 * The phone Lists Sheet's own open state (#321), lifted out to module level
 * the same shape `calendar/calendar-slide-over.ts` already uses for the
 * Calendars slide-over: the Dock's own Lists tile (`router/Dock.tsx`) has no
 * component ancestry in common with wherever `TasksListsSheet.tsx` actually
 * mounts (`TasksApp.tsx`), so there's no prop path to lift a plain
 * `useState` setter through. Both write the same boolean; the Sheet's own
 * `onOpenChange` (Escape, an outside click, picking a row) writes it back.
 */
let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return open;
}

export function useTasksListsSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function openTasksListsSheet(): void {
  open = true;
  emit();
}

export function setTasksListsSheetOpen(next: boolean): void {
  open = next;
  emit();
}

/** Test-only reset — the state above lives outside React and outside any one test's `render`, `calendar-slide-over.ts#closeCalendarSlideOver`'s own precedent. */
export function closeTasksListsSheet(): void {
  open = false;
  emit();
}
