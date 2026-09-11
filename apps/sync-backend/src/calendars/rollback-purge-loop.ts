import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import { purgeExpiredRollbacks } from "./rollback-purge.js";

/** `series-purge-loop.ts`'s own shape, scoped to `rollbacks` (#237) — an hourly tick against a 7-day window, same reasoning `note-purge-loop.ts` gives its own 30-day one. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface RollbackPurgeLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type RollbackPurgeLoopHandle = PollLoopHandle;

export function startRollbackPurgeLoop(
  db: Db,
  {
    intervalMs = DEFAULT_INTERVAL_MS,
    now = () => new Date(),
    logger,
  }: RollbackPurgeLoopOptions = {},
): RollbackPurgeLoopHandle {
  return startPollLoop({
    label: "rollback purge loop",
    intervalMs,
    logger,
    async tick() {
      const purged = await purgeExpiredRollbacks(db, now());
      if (purged > 0) logger?.info({ purged }, "rollback purge sweep");
    },
  });
}
