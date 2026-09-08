import type { FastifyBaseLogger } from "fastify";
import { deriveCredentialKey } from "../connected-accounts/credential-crypto.js";
import type { Db } from "../db/client.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import { pruneSentCompositions } from "./pending-send.js";
import { sweepDueSends } from "./send-sweeper.js";

/**
 * The scheduler for `compose/send-sweeper.ts` (#46, ADR-0007), the same
 * shape `sync/draft-push-loop.ts` and `sync/protocol-write-loop.ts` already
 * have: an interval, one short-lived connection per Mail Account that has
 * work, independent of the resident IDLE session. A thin wrapper over
 * `sync/poll-loop.ts`'s shared shape (#188).
 *
 * **The first tick runs immediately, before the first interval elapses.**
 * That is ADR-0007's boot-time sweep: `submit_after` is absolute, so
 * "a boot-time sweep submits everything due, however long the backend was
 * down. Overdue mail goes out late rather than being held for confirmation."
 * Nothing else in this file knows about restarts — an overdue row is
 * indistinguishable from one that just came due, which is exactly the
 * property that makes the restart case need no code of its own.
 */

/**
 * Tight enough that a `off`/`5s` delay is not noticeably lengthened by the
 * scheduler, cheap enough to run forever: a tick with nothing due is one
 * indexed query (`compositions_send_due_idx`) and no connection at all.
 */
const DEFAULT_INTERVAL_MS = 1_000;

export interface SendLoopOptions {
  mailCredentialKey: string;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type SendLoopHandle = PollLoopHandle;

export function startSendLoop(
  db: Db,
  { mailCredentialKey, intervalMs = DEFAULT_INTERVAL_MS, logger }: SendLoopOptions,
): SendLoopHandle {
  const credentialKey = deriveCredentialKey(mailCredentialKey);

  return startPollLoop({
    label: "compose send loop",
    intervalMs,
    logger,
    async tick() {
      const result = await sweepDueSends(db, (id) => getMailAccountById(db, id), {
        credentialKey,
        logger,
      });
      if (result.processed > 0) {
        logger?.info({ ...result }, "pending send sweep");
      }
      await pruneSentCompositions(db);
    },
  });
}
