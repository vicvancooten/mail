import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { wakeDueSnoozes } from "./snooze.js";

/**
 * The scheduler for `sync/snooze.ts`'s wake sweep (#76): a plain Postgres
 * background loop, the same "no IMAP connection, keeps running for an
 * account sitting in Needs Reauth" shape `search-index-loop.ts` already has
 * — waking a Thread only ever touches columns already stored in `threads`.
 * `main.ts` starts it once at boot, independent of `sync/manager.ts`'s
 * per-account sessions.
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

export interface SnoozeWakeLoopHandle {
  stop(): Promise<void>;
}

export function startSnoozeWakeLoop(
  db: Db,
  { intervalMs = DEFAULT_INTERVAL_MS, now = () => new Date(), logger }: SnoozeWakeLoopOptions = {},
): SnoozeWakeLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const woken = await wakeDueSnoozes(db, now());
      if (woken > 0) logger?.info({ woken }, "snooze wake sweep");
    } catch (err) {
      logger?.error({ err }, "snooze wake sweep failed");
    }
  };

  // Mirrors `compose/send-loop.ts`'s own "runs to completion before the next
  // tick is scheduled" — two sweeps overlapping would still be correct (a
  // plain conditional UPDATE), just a wasted redundant query.
  let running: Promise<void> = tick().finally(scheduleNext);

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(scheduleNext);
    }, intervalMs);
    timer.unref?.();
  }

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
