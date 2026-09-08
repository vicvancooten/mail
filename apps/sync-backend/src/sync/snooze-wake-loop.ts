import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "./poll-loop.js";
import { wakeDueSnoozes } from "./snooze.js";

/**
 * The scheduler for `sync/snooze.ts`'s wake sweep (#76): a plain Postgres
 * background loop, the same "no IMAP connection, keeps running for an
 * account sitting in Needs Reauth" shape `search-index-loop.ts` already has
 * — waking a Thread only ever touches columns already stored in `threads`.
 * `main.ts` starts it once at boot, independent of `sync/manager.ts`'s
 * per-account sessions. A thin wrapper over `poll-loop.ts`'s shared shape
 * (#188).
 *
 * **The first tick runs immediately**, same reasoning as `compose/
 * send-loop.ts`'s own boot-time sweep: `snoozeUntil` is absolute, so
 * whatever came due while the process was down wakes on this boot rather
 * than waiting out a full interval first.
 */

/** Tight enough that Snooze feels prompt without polling an idle table hard. */
const DEFAULT_INTERVAL_MS = 15_000;

export interface SnoozeWakeLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type SnoozeWakeLoopHandle = PollLoopHandle;

export function startSnoozeWakeLoop(
  db: Db,
  { intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date(), logger }: SnoozeWakeLoopOptions = {},
): SnoozeWakeLoopHandle {
  return startPollLoop({
    label: "snooze wake loop",
    intervalMs,
    logger,
    async tick() {
      const woken = await wakeDueSnoozes(db, now());
      if (woken > 0) logger?.info({ woken }, "snooze wake sweep");
    },
  });
}
