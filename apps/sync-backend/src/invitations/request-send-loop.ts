import type { FastifyBaseLogger } from "fastify";
import { deriveCredentialKey } from "../connected-accounts/credential-crypto.js";
import type { Db } from "../db/client.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { type PollLoopHandle, startPollLoop } from "../sync/poll-loop.js";
import { pruneSettledRequests } from "./local-organizer.js";
import { sweepDueRequests } from "./request-sweeper.js";

/**
 * The scheduler for `invitations/request-sweeper.ts` (#242, ADR-0027) —
 * `invitations/reply-send-loop.ts`'s own shape: the first tick runs
 * immediately, so a `REQUEST`/`CANCEL` queued while the instance was down
 * goes out on boot rather than waiting for the next interval.
 */

const DEFAULT_INTERVAL_MS = 1_000;

export interface RequestSendLoopOptions {
  mailCredentialKey: string;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export type RequestSendLoopHandle = PollLoopHandle;

export function startRequestSendLoop(
  db: Db,
  { mailCredentialKey, intervalMs = DEFAULT_INTERVAL_MS, logger }: RequestSendLoopOptions,
): RequestSendLoopHandle {
  const credentialKey = deriveCredentialKey(mailCredentialKey);

  return startPollLoop({
    label: "iMIP organiser send loop",
    intervalMs,
    logger,
    async tick() {
      const result = await sweepDueRequests(db, (id) => getMailAccountById(db, id), {
        credentialKey,
        logger,
      });
      if (result.processed > 0) {
        logger?.info({ ...result }, "iMIP organiser send sweep");
      }
      await pruneSettledRequests(db);
    },
  });
}
