import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { runSearchIndexRebuildBatch } from "./search-index.js";

/**
 * The scheduler for `sync/search-index.ts`'s rebuild sweep (#50, ADR-0016):
 * a plain Postgres background loop, deliberately **not** scoped to any one
 * Mail Account's resident IMAP session the way `sync/body-sweep.ts` is —
 * rebuilding `message_search.doc` only ever reads columns already stored in
 * `messages`, so it needs no mail-server connection and keeps running for an
 * account sitting in Needs Reauth. `main.ts` starts it once at boot,
 * independent of `sync/manager.ts`'s per-account sessions, matching
 * `sync/protocol-write-loop.ts`'s "boot starts it, `SIGTERM` stops it, tests
 * never see it unless they ask" shape.
 */

const DEFAULT_BATCH_SIZE = 200;
/** Paused between batches while there's still stale rows — keeps this from starving other DB traffic. */
const DEFAULT_PAUSE_MS = 50;
/** Paused between checks once caught up — an analyzer bump is rare, no point polling hard for it. */
const DEFAULT_IDLE_POLL_MS = 30_000;

export interface SearchIndexRebuildLoopOptions {
  batchSize?: number;
  pauseMs?: number;
  idlePollMs?: number;
  logger?: FastifyBaseLogger;
}

export interface SearchIndexRebuildLoopHandle {
  /** Stops the loop, waiting out any tick already in flight. Idempotent. */
  stop(): Promise<void>;
}

/** A tiny sleep that also resolves early on `stopSignal` — same shape as `body-sweep.ts`'s own. */
function sleep(ms: number, stopSignal: Promise<void>): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
    stopSignal,
  ]);
}

export function startSearchIndexRebuildLoop(
  db: Db,
  options: SearchIndexRebuildLoopOptions = {},
): SearchIndexRebuildLoopHandle {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  const logger = options.logger;

  let stopped = false;
  let stopResolve: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  const running = (async () => {
    while (!stopped) {
      let complete = true;
      try {
        const result = await runSearchIndexRebuildBatch(db, batchSize);
        complete = result.complete;
      } catch (err) {
        logger?.error({ err }, "search index rebuild sweep: batch failed");
      }
      if (stopped) return;
      await sleep(complete ? idlePollMs : pauseMs, stopSignal);
    }
  })();

  return {
    async stop() {
      stopped = true;
      stopResolve();
      await running;
    },
  };
}
