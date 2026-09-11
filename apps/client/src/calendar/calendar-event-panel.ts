import { useSyncExternalStore } from "react";

/**
 * The Event editor's one shared panel state (#233's own acceptance line:
 * "One popover is open at a time, gated by a single shared panel state
 * rather than independent open state per popover"). A plain module-level
 * store rather than component state — `CalendarRoute.tsx` mounts one
 * `EventEditorPopover`, but the state that decides what it shows is set
 * from several places at once (a grid cell's click handler, an `EventChip`,
 * a deep-linked `/calendar/<seriesId>@<originalStart>` route) that have no
 * component ancestry in common to lift it into.
 *
 * `anchorRect` is a plain `{x, y, width, height}` snapshot of a
 * `getBoundingClientRect()` (or a synthetic point for a plain click) — the
 * popover renders an invisible anchor `div` positioned at it
 * (`EventEditorPopover.tsx`), which is what makes Radix's own Popper
 * collision detection flip the popover near a viewport edge with no extra
 * wiring here.
 */
export interface PanelAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type EventPanelState =
  | {
      mode: "create";
      calendarId: string;
      start: string;
      end: string;
      allDay: boolean;
      anchorRect: PanelAnchorRect;
    }
  | {
      mode: "edit";
      eventId: string;
      anchorRect: PanelAnchorRect | null;
      /**
       * Set only when this Event was opened from a fired Reminder's own
       * notification click (#246, ADR-0028) — the one way the Event page
       * ever learns a Reminder just fired for it, since that state is
       * "server-side only; the Client never syncs it" (ADR-0028). Drives
       * the popover's own Snooze row; absent for every ordinary open (a
       * grid click, a plain deep link).
       */
      reminderDueIds?: string[];
    }
  | null;

let state: EventPanelState = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): EventPanelState {
  return state;
}

export function useEventPanelState(): EventPanelState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function openCreatePanel(params: {
  calendarId: string;
  start: string;
  end: string;
  allDay: boolean;
  anchorRect: PanelAnchorRect;
}): void {
  state = { mode: "create", ...params };
  emit();
}

export function openEditPanel(
  eventId: string,
  anchorRect: PanelAnchorRect | null,
  reminderDueIds?: string[],
): void {
  state = {
    mode: "edit",
    eventId,
    anchorRect,
    reminderDueIds: reminderDueIds ?? takePendingReminderDueIds(eventId),
  };
  emit();
}

/**
 * A "Reminder fired for this Event" click (#246) navigates through
 * `router/CalendarEventRoute.tsx`, which only ever calls `openEditPanel`
 * with the bare `eventId` from the URL — there is no way to hand it
 * `reminderDueIds` directly. `router/RootLayout.tsx` stages them here right
 * before navigating; `openEditPanel` above claims them back the moment it
 * opens the matching Event, so a plain later re-open of the same Event
 * (a grid click, a fresh deep link) never inherits a stale Snooze row.
 */
let pendingReminderClick: { eventId: string; reminderDueIds: string[] } | null = null;

export function stagePendingReminderClick(eventId: string, reminderDueIds: string[]): void {
  pendingReminderClick = { eventId, reminderDueIds };
}

function takePendingReminderDueIds(eventId: string): string[] | undefined {
  if (pendingReminderClick?.eventId !== eventId) return undefined;
  const { reminderDueIds } = pendingReminderClick;
  pendingReminderClick = null;
  return reminderDueIds;
}

export function closeEventPanel(): void {
  state = null;
  emit();
}

/** A `DOMRect`-shaped snapshot of a plain click point — no real element behind it, just where the User clicked. */
export function pointAnchorRect(x: number, y: number): PanelAnchorRect {
  return { x, y, width: 0, height: 0 };
}

export function elementAnchorRect(element: Element): PanelAnchorRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
