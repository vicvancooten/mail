import type { FastifyBaseLogger } from "fastify";
import { purgeExpiredContacts } from "../contacts/contact-purge.js";
import type { Db } from "../db/client.js";
import { type PollLoopHandle, startPollLoop } from "./poll-loop.js";

/**
 * The scheduler for `contact-purge.ts`'s sweep (#224) — `note-purge-loop.ts`'s
 * own shape exactly: a plain Postgres background loop `main.ts` starts once
 * at boot, independent of `sync/manager.ts`'s per-account sessions and of
 * `contacts/google/poll-loop.ts`/`contacts/microsoft/poll-loop.ts`'s own
 * per-Connected-Account schedules, since purging only ever touches columns
 * already stored on `contacts`.
 *
 * The 30-day retention window (`CONTACT_TRASH_RETENTION_DAYS`) has no
 * minute-level urgency the way a Snooze wake does, so this ticks far less
 * often — hourly is close enough that "gone from Recently Deleted at that
 * point" (this ticket's own acceptance line) never drifts by more than a
 * sliver of the window itself.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface ContactPurgeLoopOptions {
  intervalMs?: number;
  now?: () => Date;
  logger?: FastifyBaseLogger;
}

export type ContactPurgeLoopHandle = PollLoopHandle;

export function startContactPurgeLoop(
  db: Db,
  {
    intervalMs = DEFAULT_INTERVAL_MS,
    now = () => new Date(),
    logger,
  }: ContactPurgeLoopOptions = {},
): ContactPurgeLoopHandle {
  return startPollLoop({
    label: "contact purge loop",
    intervalMs,
    logger,
    async tick() {
      const purged = await purgeExpiredContacts(db, now());
      if (purged > 0) logger?.info({ purged }, "contact purge sweep");
    },
  });
}
