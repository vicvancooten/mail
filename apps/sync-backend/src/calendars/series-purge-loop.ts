import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import { purgeExpiredSeries } from "./series-purge.js";

/**
 * The scheduler for `series-purge.ts`'s sweep (#233) — `note-purge-loop.ts`'s
 * own shape exactly, just ticking far more often: the retention window here
 * is hours, not days, so an hourly tick (`note-purge-loop.ts`'s own
 * interval) would let a purge lag most of the window itself.
 */

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface SeriesPurgeLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type SeriesPurgeLoopHandle = PollLoopHandle;

export function startSeriesPurgeLoop(
  db: Db,
  { intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date(), logger }: SeriesPurgeLoopOptions = {},
): SeriesPurgeLoopHandle {
  return startPollLoop({
    label: "series purge loop",
    intervalMs,
    logger,
    async tick() {
      const purged = await purgeExpiredSeries(db, now());
      if (purged > 0) logger?.info({ purged }, "series purge sweep");
    },
  });
}
