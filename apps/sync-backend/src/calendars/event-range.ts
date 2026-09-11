import type { Event } from "@mail/shared";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { events, overrides, type SeriesRow, series } from "../db/schema.js";
import { toWireEvent } from "./event-store.js";
import { computeMaterialisationWindow } from "./materialise-loop.js";
import { materialiseSeries, type OverrideInput } from "./materialiser.js";

/**
 * `GET /calendars/events` (#232): answers a range request that reaches
 * outside the Event Window — the one place the Client fetches Occurrences
 * through anything other than `POST /sync`'s cursor. Splits `[start, end]`
 * against the Materialisation Window (`materialise-loop.ts`):
 *
 * - The overlap with the Materialisation Window reads stored `events` rows
 *   directly, by `startAt`/`endAt`, never joining the sync delta or its
 *   cursor (this ticket's first acceptance line) — those rows already exist
 *   because the daily materialise sweep put them there.
 * - Whatever falls outside the Materialisation Window (either edge) is
 *   never a stored row, so it is computed by calling the materialiser
 *   (`materialiser.ts#materialiseSeries`) directly over every Series this
 *   User owns, the same expansion `series-store.ts#rematerialiseSeries`
 *   does, minus the write — nothing is upserted or tombstoned for this
 *   (this ticket's last acceptance line).
 */
export async function fetchEventRange(
  db: Db,
  userId: string,
  start: Date,
  end: Date,
): Promise<Event[]> {
  const matWindow = computeMaterialisationWindow();
  const results: Event[] = [];

  const storedStart = start < matWindow.start ? matWindow.start : start;
  const storedEnd = end > matWindow.end ? matWindow.end : end;
  if (storedStart < storedEnd) {
    results.push(...(await fetchStoredEventsForRange(db, userId, storedStart, storedEnd)));
  }

  if (start < matWindow.start) {
    const beforeEnd = end < matWindow.start ? end : matWindow.start;
    if (start < beforeEnd) {
      results.push(...(await materialiseRangeReadOnly(db, userId, start, beforeEnd)));
    }
  }

  if (end > matWindow.end) {
    const afterStart = start > matWindow.end ? start : matWindow.end;
    if (afterStart < end) {
      results.push(...(await materialiseRangeReadOnly(db, userId, afterStart, end)));
    }
  }

  results.sort((left, right) => left.start.localeCompare(right.start));
  return results;
}

async function fetchStoredEventsForRange(
  db: Db,
  userId: string,
  start: Date,
  end: Date,
): Promise<Event[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), lt(events.startAt, end), gt(events.endAt, start)));
  return rows.map(toWireEvent);
}

/** The read-only twin of `series-store.ts#rematerialiseSeries` — same expansion, no `events` write, no tombstone. */
async function materialiseRangeReadOnly(
  db: Db,
  userId: string,
  start: Date,
  end: Date,
): Promise<Event[]> {
  const seriesRows = await db.select().from(series).where(eq(series.userId, userId));
  if (seriesRows.length === 0) return [];

  const overrideRows = await db
    .select()
    .from(overrides)
    .where(
      inArray(
        overrides.seriesId,
        seriesRows.map((row) => row.id),
      ),
    );
  const overridesBySeriesId = new Map<string, Map<string, OverrideInput>>();
  for (const row of overrideRows) {
    const bySeries = overridesBySeriesId.get(row.seriesId) ?? new Map<string, OverrideInput>();
    bySeries.set(row.originalStart.toISOString(), {
      originalStart: row.originalStart,
      start: row.start,
      end: row.end,
      title: row.title,
      location: row.location,
    });
    overridesBySeriesId.set(row.seriesId, bySeries);
  }

  const result: Event[] = [];
  for (const seriesRow of seriesRows) {
    const occurrences = materialiseSeries(
      seriesInputFor(seriesRow),
      overridesBySeriesId.get(seriesRow.id) ?? new Map(),
      start,
      end,
    );
    for (const occurrence of occurrences) {
      result.push({
        id: `${seriesRow.id}@${occurrence.originalStart.toISOString()}`,
        calendarId: seriesRow.calendarId,
        seriesId: seriesRow.id,
        originalStart: occurrence.originalStart.toISOString(),
        start: occurrence.start.toISOString(),
        end: occurrence.end.toISOString(),
        allDay: seriesRow.allDay,
        tzid: seriesRow.tzid,
        floating: seriesRow.floating,
        title: occurrence.title,
        location: occurrence.location,
        status: "confirmed",
        transparency: seriesRow.transparency,
        updatedAt: seriesRow.updatedAt.toISOString(),
      });
    }
  }
  return result;
}

function seriesInputFor(row: SeriesRow) {
  return {
    dtstart: row.dtstart,
    durationMs: row.durationMs,
    rrules: row.rrules,
    rdates: row.rdates,
    exdates: row.exdates,
    tzid: row.tzid,
    title: row.title,
    location: row.location,
  };
}
