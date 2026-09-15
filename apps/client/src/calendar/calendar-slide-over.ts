import { useSyncExternalStore } from "react";

/**
 * The Calendars slide-over's own open state (#318), lifted out of
 * `CalendarRoute.tsx`'s local `useState` into a module-level store the same
 * shape `calendar-event-panel.ts` already uses for the create/edit/task
 * popover — the Dock's own Calendars tile (`router/Dock.tsx`) has no
 * component ancestry in common with `CalendarRoute`'s own toolbar button,
 * so there's no prop path to lift a plain `useState` setter through. Both
 * now write the same boolean; `CalendarSlideOver`'s own `onOpenChange`
 * (Escape, an outside click, dragging the sheet closed) writes it back.
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

export function useCalendarSlideOverOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function openCalendarSlideOver(): void {
  open = true;
  emit();
}

export function setCalendarSlideOverOpen(next: boolean): void {
  open = next;
  emit();
}

/** Test-only reset — the state above lives outside React and outside any one test's `render`, `calendar-event-panel.ts`'s own `closeEventPanel` precedent. */
export function closeCalendarSlideOver(): void {
  open = false;
  emit();
}
