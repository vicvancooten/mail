import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { protocolWrites } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { withMailAccountConnection } from "./imap-connection.js";
import { drainProtocolWrites } from "./protocol-writes.js";

/**
 * The scheduler for `sync/protocol-writes.ts` (#42): a short-lived
 * connection per Mail Account with anything queued, opened and closed on a
 * fixed interval — deliberately independent of the resident IDLE session
 * (`sync/live-session.ts`). Two reasons: a mutation-flush inside `POST
 * /sync` never has that session's live `ImapFlow` handle to hand (it lives
 * in a different process concern, `sync/manager.ts`'s registry), and a
 * write-through that shares the IDLE connection would make a slow Archive
 * folder able to stall IDLE on INBOX. `main.ts` is the only real caller,
 * matching `sync/manager.ts`'s own pattern of "boot starts it, `SIGTERM`
 * stops it, tests never see it unless they ask".
 */

const DEFAULT_INTERVAL_MS = 3_000;

export interface ProtocolWriteLoopOptions {
  /** `env.MAIL_CREDENTIAL_KEY`, raw. */
  mailCredentialKey: string;
  /** How often the outbox is checked. Default 3s — write-through is "asynchronous", not "instant". */
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export interface ProtocolWriteLoopHandle {
  /** Stops the loop, waiting out any tick already in flight. Idempotent. */
  stop(): Promise<void>;
}

export function startProtocolWriteLoop(
  db: Db,
  { mailCredentialKey, intervalMs = DEFAULT_INTERVAL_MS, logger }: ProtocolWriteLoopOptions,
): ProtocolWriteLoopHandle {
  const credentialKey = deriveCredentialKey(mailCredentialKey);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick().finally(scheduleNext);
    }, intervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    let accountIds: string[];
    try {
      accountIds = await pendingMailAccountIds(db);
    } catch (err) {
      logger?.error({ err }, "protocol write loop: failed to list pending accounts");
      return;
    }
    for (const accountId of accountIds) {
      if (stopped) return;
      try {
        await drainAccount(db, accountId, credentialKey);
      } catch (err) {
        logger?.error({ err, accountId }, "protocol write loop: drain failed");
      }
    }
  };

  scheduleNext();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

async function pendingMailAccountIds(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ mailAccountId: protocolWrites.mailAccountId })
    .from(protocolWrites);
  return rows.map((row) => row.mailAccountId);
}

async function drainAccount(db: Db, mailAccountId: string, credentialKey: Buffer): Promise<void> {
  const account = await getMailAccountById(db, mailAccountId);
  // Gone, or waiting on the User to re-enter credentials (CONTEXT.md: queued
  // Optimistic Actions hold rather than fail on Needs Reauth) — either way,
  // nothing here can make progress, and the rows stay queued until the
  // account is live again.
  if (!account || account.status === "needs_reauth") return;

  await withMailAccountConnection(db, account, { credentialKey }, (client) =>
    drainProtocolWrites(db, client, mailAccountId),
  );
}
