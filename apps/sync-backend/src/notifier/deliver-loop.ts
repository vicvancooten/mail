import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import { deliverPending, type SendPushFn } from "./deliver.js";

/**
 * The scheduler for `deliver.ts` (#53, ADR-0015), the same shape
 * `compose/send-loop.ts`/`sync/protocol-write-loop.ts` already have: a short
 * interval, independent of anything else. **The first tick runs immediately**
 * — this is what makes a container restart resumable rather than a silent
 * drop: whatever the outbox held when the process died is exactly what this
 * boot-time tick picks back up (`db/schema.ts`'s own doc comment on why the
 * outbox is durable in the first place). A thin wrapper over
 * `sync/poll-loop.ts`'s shared shape (#188).
 */
const DEFAULT_INTERVAL_MS = 2_000;

export interface DeliverLoopOptions {
  sendPush: SendPushFn;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type DeliverLoopHandle = PollLoopHandle;

export function startNotifierDeliverLoop(
  db: Db,
  { sendPush, intervalMs = DEFAULT_INTERVAL_MS, logger }: DeliverLoopOptions,
): DeliverLoopHandle {
  return startPollLoop({
    label: "notifier deliver loop",
    intervalMs,
    logger,
    async tick() {
      const result = await deliverPending(db, { sendPush });
      if (result.sent > 0 || result.collapsed > 0 || result.pruned > 0) {
        logger?.info({ ...result }, "notifier delivery tick");
      }
    },
  });
}
