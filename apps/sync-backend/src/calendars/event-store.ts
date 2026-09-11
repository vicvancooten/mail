import { EVENT_WINDOW_MONTHS_FUTURE, EVENT_WINDOW_MONTHS_PAST, type Event } from "@mail/shared";
import type { EventRow } from "../db/schema.js";

/** Maps a stored Event (Occurrence) row to ADR-0011's wire projection — written by `calendars/series-store.ts#rematerialiseSeries`, kept beside `toWireCalendar` for the same "projection lives next to its table" convention. */
export function toWireEvent(row: EventRow): Event {
  return {
    id: row.id,
    calendarId: row.calendarId,
    seriesId: row.seriesId,
    originalStart: row.originalStart.toISOString(),
    start: row.startAt.toISOString(),
    end: row.endAt.toISOString(),
    allDay: row.allDay,
    tzid: row.tzid,
    floating: row.floating,
    title: row.title,
    location: row.location,
    status: row.status,
    transparency: row.transparency,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The Event Window's edges (CONTEXT.md, ADR-0025), recomputed from "now" — always a sub-range of `calendars/materialise-loop.ts`'s wider, actually-persisted Materialisation Window. */
export function computeEventWindow(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setMonth(start.getMonth() - EVENT_WINDOW_MONTHS_PAST);
  const end = new Date(now);
  end.setMonth(end.getMonth() + EVENT_WINDOW_MONTHS_FUTURE);
  return { start, end };
}
