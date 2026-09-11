import type { FastifyBaseLogger } from "fastify";
import { deriveCredentialKey } from "../connected-accounts/credential-crypto.js";
import type { Db } from "../db/client.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import { pruneSettledReplies } from "./local-answer.js";
import { sweepDueReplies } from "./reply-sweeper.js";

/**
 * The scheduler for `invitations/reply-sweeper.ts` (#241, ADR-0007) —
 * `compose/send-loop.ts`'s own shape: the first tick runs immediately, so an
 * overdue `REPLY` (the instance was down through its whole Undo Send delay)
 * goes out on boot rather than waiting for the next interval.
 */

const DEFAULT_INTERVAL_MS = 1_000;

export interface ReplySendLoopOptions {
  mailCredentialKey: string;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type ReplySendLoopHandle = PollLoopHandle;

export function startReplySendLoop(
  db: Db,
  { mailCredentialKey, intervalMs = DEFAULT_INTERVAL_MS, logger }: ReplySendLoopOptions,
): ReplySendLoopHandle {
  const credentialKey = deriveCredentialKey(mailCredentialKey);

  return startPollLoop({
    label: "iMIP reply send loop",
    intervalMs,
    logger,
    async tick() {
      const result = await sweepDueReplies(db, (id) => getMailAccountById(db, id), {
        credentialKey,
        logger,
      });
      if (result.processed > 0) {
        logger?.info({ ...result }, "iMIP reply sweep");
      }
      await pruneSettledReplies(db);
    },
  });
}
