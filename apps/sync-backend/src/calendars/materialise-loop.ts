import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import { rematerialiseSeries, selectMaterialisableSeries } from "./series-store.js";

/**
 * The Materialisation Window (#230, ADR-0025): "about a year back, two
 * forward ... where Occurrences exist as stored rows and rolls daily." Wider
 * than the Event Window a Client actually syncs
 * (`packages/shared/src/events.ts`) — it is what is actually persisted, the
 * edge this loop is the one thing that advances (`db/schema.ts#events`' own
 * doc comment).
 */
export const MATERIALISATION_WINDOW_YEARS_PAST = 1;
export const MATERIALISATION_WINDOW_YEARS_FUTURE = 2;

export function computeMaterialisationWindow(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - MATERIALISATION_WINDOW_YEARS_PAST);
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + MATERIALISATION_WINDOW_YEARS_FUTURE);
  return { start, end };
}

/**
 * Re-materialises every Series once a day (`note-purge-loop.ts`'s own
 * shape: a plain Postgres background loop, no IMAP connection, started once
 * at boot). Runs its first tick immediately — the same
 * `deliver-loop.ts` reasoning applies: whatever the window looked like when
 * the process last ran is exactly what this boot-time tick brings current,
 * rather than leaving a fresh Series unmaterialised until the next midnight.
 *
 * Account-wide, not scoped to one User, the same posture `purgeExpiredNotes`
 * takes — a Series carries its own `userId`/`calendarId` already, so one
 * sweep serves every User's Series in one pass.
 */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MaterialiseLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type MaterialiseLoopHandle = PollLoopHandle;

export function startMaterialiseLoop(
  db: Db,
  { intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date(), logger }: MaterialiseLoopOptions = {},
): MaterialiseLoopHandle {
  return startPollLoop({
    label: "series materialise loop",
    intervalMs,
    logger,
    async tick() {
      const window = computeMaterialisationWindow(now());
      const seriesRows = await selectMaterialisableSeries(db);
      for (const seriesRow of seriesRows) {
        await rematerialiseSeries(db, seriesRow, window.start, window.end);
      }
      if (seriesRows.length > 0) {
        logger?.info({ seriesCount: seriesRows.length }, "series materialise sweep");
      }
    },
  });
}
