import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "./poll-loop.js";
import { purgeExpiredTombstones } from "./trash-purge.js";

/**
 * The scheduler for `trash-purge.ts`'s sweep (#194, generalised by #257) —
 * `snooze-wake-loop.ts`'s own shape exactly: a plain Postgres background
 * loop `main.ts` starts once at boot, independent of `sync/manager.ts`'s
 * per-account sessions, no IMAP connection needed since purging only ever
 * touches columns already stored on the retention-bearing tables themselves.
 *
 * No retention-bearing collection's own window has minute-level urgency the
 * way a Snooze wake does, so this ticks far less often — hourly is close
 * enough that "gone from Recently Deleted at that point" (#194's own
 * acceptance line, generalised to every collection this sweep now covers)
 * never drifts by more than a sliver of the window itself.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface TrashPurgeLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type TrashPurgeLoopHandle = PollLoopHandle;

export function startTrashPurgeLoop(
  db: Db,
  { intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date(), logger }: TrashPurgeLoopOptions = {},
): TrashPurgeLoopHandle {
  return startPollLoop({
    label: "trash purge loop",
    intervalMs,
    logger,
    async tick() {
      const purged = await purgeExpiredTombstones(db, now());
      if (purged > 0) logger?.info({ purged }, "trash purge sweep");
    },
  });
}
