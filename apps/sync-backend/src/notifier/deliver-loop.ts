import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { deliverPending, type SendPushFn } from "./deliver.js";

/**
 * The scheduler for `deliver.ts` (#53, ADR-0015), the same shape
 * `compose/send-loop.ts`/`sync/protocol-write-loop.ts` already have: a short
 * interval, independent of anything else. **The first tick runs immediately**
 * — this is what makes a container restart resumable rather than a silent
 * drop: whatever the outbox held when the process died is exactly what this
 * boot-time tick picks back up (`db/schema.ts`'s own doc comment on why the
 * outbox is durable in the first place).
 */
const DEFAULT_INTERVAL_MS = 2_000;

export interface DeliverLoopOptions {
  sendPush: SendPushFn;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export interface DeliverLoopHandle {
  stop(): Promise<void>;
}

export function startNotifierDeliverLoop(
  db: Db,
  { sendPush, intervalMs = DEFAULT_INTERVAL_MS, logger }: DeliverLoopOptions,
): DeliverLoopHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await deliverPending(db, { sendPush });
      if (result.sent > 0 || result.collapsed > 0 || result.pruned > 0) {
        logger?.info({ ...result }, "notifier delivery tick");
      }
    } catch (err) {
      logger?.error({ err }, "notifier delivery tick failed");
    }
  };

  // Runs to completion before the next tick is scheduled — two ticks
  // overlapping would double-attempt the same still-undelivered rows for no
  // gain, the same reasoning `send-loop.ts` gives for its own interval.
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
