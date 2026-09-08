import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { purgeExpiredNotes } from "./note-purge.js";
import { type PollLoopHandle, startPollLoop } from "./poll-loop.js";

/**
 * The scheduler for `note-purge.ts`'s sweep (#194) — `snooze-wake-loop.ts`'s
 * own shape exactly: a plain Postgres background loop `main.ts` starts once
 * at boot, independent of `sync/manager.ts`'s per-account sessions, no IMAP
 * connection needed since purging only ever touches columns already stored
 * on `notes`.
 *
 * The 30-day retention window (`NOTE_TRASH_RETENTION_DAYS`) has no minute-level
 * urgency the way a Snooze wake does, so this ticks far less often —
 * hourly is close enough that "gone from Recently Deleted at that point"
 * (#194's own acceptance line) never drifts by more than a sliver of the
 * window itself.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface NotePurgeLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type NotePurgeLoopHandle = PollLoopHandle;

export function startNotePurgeLoop(
  db: Db,
  { intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date(), logger }: NotePurgeLoopOptions = {},
): NotePurgeLoopHandle {
  return startPollLoop({
    label: "note purge loop",
    intervalMs,
    logger,
    async tick() {
      const purged = await purgeExpiredNotes(db, now());
      if (purged > 0) logger?.info({ purged }, "note purge sweep");
    },
  });
}
