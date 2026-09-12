import type { Calendar, Event } from "@mail/shared";
import { announceUndoableAction } from "../mail/undo-toast.js";
import type { CachedSeries } from "../store/db.js";
import {
  createSeries,
  hydrateSeries,
  newOverrideId,
  newSeriesId,
  type SeriesBodyFields,
  saveSeriesBody,
  trashSeries,
} from "../store/series.js";
import type { CivilDate } from "./calendar-dates.js";
import { openEventMoveScopePrompt } from "./calendar-event-move-panel.js";
import { type CivilInstant, civilInstantToIso, eventStart } from "./calendar-occurrences.js";
import { withUntil } from "./recurrence.js";

/**
 * Dragging a recurring Occurrence (#305's own acceptance line: "asks whether
 * to change this event, this and following, or all, before anything is
 * written") — `EventEditorPopover.tsx`'s own `EditScope`, hoisted here so the
 * drag path and the edit-form path share one name for the same three writes
 * rather than drifting into two.
 */
export type EventDragScope = "this" | "all" | "thisAndFollowing";

/** A read-only Calendar never starts a drag (#305's own acceptance line) — the same `capabilities.writable` gate `EventEditorPopover.tsx#readOnlyEdit` already reads. */
export function isDraggableCalendar(calendar: Calendar | undefined): boolean {
  return calendar?.capabilities.writable === true;
}

/** Day and Week's own snap (#305): the nearest quarter-hour, clamped inside one civil day. */
export function snapToQuarterHour(minutesPastMidnight: number): number {
  const snapped = Math.round(minutesPastMidnight / 15) * 15;
  return Math.min(Math.max(snapped, 0), 24 * 60 - 15);
}

/**
 * Where a drag actually lands (#305): `targetDay` always replaces the
 * Occurrence's own date; `targetMinutes` (`null` for Month's day-only drop)
 * replaces its time of day too — Month's drag never touches the hour/minute
 * an Occurrence already carries, which is what "snaps ... to a day in month"
 * (this ticket's own acceptance line) means for a timed Occurrence dropped
 * on a Month cell.
 */
export function resolveDraggedInstant(
  current: CivilInstant,
  targetDay: CivilDate,
  targetMinutes: number | null,
): CivilInstant {
  return {
    year: targetDay.year,
    month: targetDay.month,
    day: targetDay.day,
    hour: targetMinutes === null ? current.hour : Math.floor(targetMinutes / 60),
    minute: targetMinutes === null ? current.minute : targetMinutes % 60,
  };
}

/** What a drag's own drop target resolves to, once wired through `civilInstantToIso` — everything `commitEventMove` needs to actually write. */
export interface DraggedOccurrence {
  event: Event;
  series: CachedSeries;
  /** The Occurrence's new start, as a wire ISO string (`civilInstantToIso`'s own wall-clock/local split). */
  nextStartIso: string;
  /** `nextStartIso` plus this Occurrence's own current duration — a drag only ever moves an Occurrence, never resizes it (a later ticket's own screen). */
  nextEndIso: string;
}

/**
 * The whole pointer-drop's own entry point (#305): resolves the drop
 * (`resolveDroppedOccurrence`, `null`s out on a no-op or a read-only
 * Calendar) and either commits it immediately — a non-recurring Series has
 * only one Occurrence, so there is nothing "this"/"all"/"thisAndFollowing"
 * could mean differently, and it commits as `"all"` with no prompt — or, for
 * a recurring Series, opens the scope prompt (`calendar-event-move-panel.ts`)
 * and leaves the actual write to whichever button the User presses there.
 * Every grid's own pointer handler calls this and nothing else.
 */
export async function handleEventDrop(
  event: Event,
  calendar: Calendar | undefined,
  targetDay: CivilDate,
  targetMinutes: number | null,
): Promise<void> {
  const dropped = await resolveDroppedOccurrence(event, calendar, targetDay, targetMinutes);
  if (!dropped) return;
  if (dropped.series.rrules.length === 0) {
    await commitEventMove(dropped, "all");
    return;
  }
  openEventMoveScopePrompt(dropped);
}

/**
 * Resolves a chip's pointer-drop into the absolute write a `commitEventMove`
 * call needs (#305) — `null` for a no-op drop (the snapped target is exactly
 * where the Occurrence already was) or a Calendar the Series turned out not
 * to be writable on after all (`isDraggableCalendar`, re-checked here since
 * the grid's own gate only ever sees the Occurrence's cached Calendar, which
 * can be stale). Fetches the Series body fresh (`hydrateSeries`) the same way
 * `EventEditorPopover.tsx`'s own edit-open effect does — a drag needs to know
 * `rrules` to decide whether `beginEventDrag`'s caller owes the User a scope
 * prompt at all.
 */
export async function resolveDroppedOccurrence(
  event: Event,
  calendar: Calendar | undefined,
  targetDay: CivilDate,
  targetMinutes: number | null,
): Promise<DraggedOccurrence | null> {
  if (!isDraggableCalendar(calendar)) return null;
  const wallClock = event.allDay || event.floating;
  const current = eventStart(event);
  const next = resolveDraggedInstant(current, targetDay, targetMinutes);
  const nextStartIso = civilInstantToIso(next, wallClock);
  if (nextStartIso === event.start) return null;

  const durationMs = new Date(event.end).getTime() - new Date(event.start).getTime();
  const nextEndIso = new Date(new Date(nextStartIso).getTime() + durationMs).toISOString();
  const series = await hydrateSeries(event.calendarId, event.seriesId);
  return { event, series, nextStartIso, nextEndIso };
}

/** Every `SeriesBodyFields` a write keeps unchanged, read straight off the cached Series — every scope below only ever overrides the handful of fields its own write actually means to change. */
function unchangedFields(series: CachedSeries): SeriesBodyFields {
  return {
    title: series.title,
    description: series.description,
    location: series.location,
    allDay: series.allDay,
    floating: series.floating,
    tzid: series.tzid,
    dtstart: series.dtstart,
    durationMs: series.durationMs,
    rrules: series.rrules,
    rdates: series.rdates,
    exdates: series.exdates,
    transparency: series.transparency,
    attendees: series.attendees,
    reminders: series.reminders,
    overrides: series.overrides.map(({ seriesId: _seriesId, ...rest }) => rest),
  };
}

/**
 * Commits a dropped drag (#305), the drag path's own counterpart to
 * `EventEditorPopover.tsx#performSave`'s three scope branches — a drag never
 * touches title, recurrence, attendees or any other body field, only ever
 * the Occurrence's own start/end, so each branch below patches exactly one
 * thing and leaves the rest of `unchangedFields` alone. Always announces its
 * own Undo (#305's own acceptance line: "Undo from the toast restores the
 * original time") with a real inverse, never a re-fetch — the same
 * `announceUndoableAction` shape `EventEditorPopover.tsx#handleMoveTo`
 * already uses for a Move.
 */
export async function commitEventMove(
  dropped: DraggedOccurrence,
  scope: EventDragScope,
): Promise<void> {
  const { event, series, nextStartIso, nextEndIso } = dropped;
  const base = unchangedFields(series);

  if (scope === "this") {
    const previousOverride = series.overrides.find((o) => o.originalStart === event.originalStart);
    const others = base.overrides.filter((o) => o.originalStart !== event.originalStart);
    const overrideId = previousOverride?.id ?? newOverrideId();
    await saveSeriesBody(series.id, series.calendarId, {
      ...base,
      overrides: [
        ...others,
        {
          id: overrideId,
          originalStart: event.originalStart,
          start: nextStartIso,
          end: nextEndIso,
          title: previousOverride?.title ?? null,
          location: previousOverride?.location ?? null,
        },
      ],
    });
    announceUndoableAction("eventReschedule", () => {
      void saveSeriesBody(series.id, series.calendarId, {
        ...base,
        overrides: previousOverride ? [...others, previousOverride] : others,
      });
    });
    return;
  }

  if (scope === "all") {
    const deltaMs = new Date(nextStartIso).getTime() - new Date(event.start).getTime();
    const nextDtstart = new Date(new Date(series.dtstart).getTime() + deltaMs).toISOString();
    await saveSeriesBody(series.id, series.calendarId, { ...base, dtstart: nextDtstart });
    announceUndoableAction("eventReschedule", () => {
      void saveSeriesBody(series.id, series.calendarId, { ...base, dtstart: series.dtstart });
    });
    return;
  }

  // "thisAndFollowing" (#305): `performSave`'s own split — cap the old
  // Series just before this Occurrence, then create its continuation as a
  // brand-new Series starting exactly where the drag dropped it.
  const cutover = new Date(event.originalStart);
  cutover.setSeconds(cutover.getSeconds() - 1);
  const cappedRrules = withUntil(series.rrules, cutover, series.allDay);
  await saveSeriesBody(series.id, series.calendarId, { ...base, rrules: cappedRrules });

  const continuationId = newSeriesId();
  await createSeries(continuationId, series.calendarId);
  await saveSeriesBody(continuationId, series.calendarId, {
    ...base,
    dtstart: nextStartIso,
    rrules: series.rrules,
    rdates: [],
    exdates: [],
    overrides: [],
  });

  announceUndoableAction("eventReschedule", () => {
    void saveSeriesBody(series.id, series.calendarId, { ...base, rrules: series.rrules });
    void trashSeries(continuationId);
  });
}
