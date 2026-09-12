import { useSyncExternalStore } from "react";
import type { DraggedOccurrence } from "./calendar-event-drag.js";

/**
 * The one shared state a dropped drag on a recurring Occurrence needs before
 * anything is written (#305's own acceptance line: "asks whether to change
 * this event, this and following, or all, before anything is written") —
 * `calendar-event-panel.ts`'s own module-level-store shape, since the same
 * "no component ancestry in common" problem applies here: `DayTimeGrid.tsx`
 * and `MonthGrid.tsx` each resolve their own drops, but `EventMoveScopeDialog.tsx`
 * is one instance mounted once in `CalendarRoute.tsx`.
 *
 * Only ever set for a *recurring* drop (`rrules.length > 0`) — a non-recurring
 * Series has nothing to choose between, so its caller commits the "all"
 * scope directly and never touches this store at all.
 *
 * `kind` (#306) is the only thing distinguishing a resized drop from a moved
 * one once it reaches this store — both resolve to the exact same
 * `DraggedOccurrence` shape (an absolute next start/end), so `EventMoveScopeDialog.tsx`
 * reads it to pick the right copy and the right commit (`commitEventMove` vs
 * `commitEventResize`) rather than this module growing a second, near-identical
 * store.
 */
export type EventScopePromptKind = "move" | "resize";

export interface PendingEventScopePrompt {
  kind: EventScopePromptKind;
  dropped: DraggedOccurrence;
}

let pending: PendingEventScopePrompt | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PendingEventScopePrompt | null {
  return pending;
}

export function usePendingEventMove(): PendingEventScopePrompt | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function openEventMoveScopePrompt(
  dropped: DraggedOccurrence,
  kind: EventScopePromptKind = "move",
): void {
  pending = { kind, dropped };
  emit();
}

/** Cancelling the prompt (#305's own acceptance line: "before anything is written") — nothing was ever written, so there is nothing to roll back. */
export function closeEventMoveScopePrompt(): void {
  pending = null;
  emit();
}
