import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "./poll-loop.js";
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
 *
 * A thin wrapper over `poll-loop.ts`'s shared shape (#188): its variable
 * pause — short while there's still stale rows, long once caught up — is
 * exactly what `poll-loop.ts`'s `nextDelayMs` exists for.
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

export type SearchIndexRebuildLoopHandle = PollLoopHandle;

export function startSearchIndexRebuildLoop(
  db: Db,
  options: SearchIndexRebuildLoopOptions = {},
): SearchIndexRebuildLoopHandle {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const idlePollMs = options.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  const logger = options.logger;

  return startPollLoop({
    label: "search index rebuild loop",
    // The very first delay is unused — the first tick is immediate — but a
    // value is still required up front; `nextDelayMs` picks every delay
    // after that from each tick's own result.
    intervalMs: idlePollMs,
    logger,
    async tick() {
      return runSearchIndexRebuildBatch(db, batchSize);
    },
    // A tick that threw has no result (`poll-loop.ts` already logged it) —
    // treated the same as "complete", matching the original sweep's own
    // `let complete = true` default that a caught error never overwrites.
    nextDelayMs: (result) => ((result?.complete ?? true) ? idlePollMs : pauseMs),
  });
}
