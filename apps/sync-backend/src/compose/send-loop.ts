import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { pruneSentCompositions } from "./pending-send.js";
import { sweepDueSends } from "./send-sweeper.js";

/**
 * The scheduler for `compose/send-sweeper.ts` (#46, ADR-0007), the same
 * shape `sync/draft-push-loop.ts` and `sync/protocol-write-loop.ts` already
 * have: an interval, one short-lived connection per Mail Account that has
 * work, independent of the resident IDLE session.
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

export interface SendLoopHandle {
  stop(): Promise<void>;
}

export function startSendLoop(
  db: Db,
  { mailCredentialKey, intervalMs = DEFAULT_INTERVAL_MS, logger }: SendLoopOptions,
): SendLoopHandle {
  const credentialKey = deriveCredentialKey(mailCredentialKey);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await sweepDueSends(db, (id) => getMailAccountById(db, id), {
        credentialKey,
        logger,
      });
      if (result.processed > 0) {
        logger?.info({ ...result }, "pending send sweep");
      }
      await pruneSentCompositions(db);
    } catch (err) {
      logger?.error({ err }, "pending send sweep failed");
    }
  };

  // Runs to completion before the next tick is scheduled, so two sweeps
  // never overlap. Overlapping ones would still be *correct* — the claim is
  // atomic — but they would double the connections to a slow SMTP server for
  // no gain.
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
