import { and, eq, lte } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { compositions } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { DRAFT_PUSH_IDLE_MS, pushDraftsForAccount } from "./draft-push.js";
import { withMailAccountConnection } from "./imap-connection.js";

/**
 * The scheduler for `sync/draft-push.ts` (#45), matching
 * `sync/protocol-write-loop.ts`'s own shape: a short-lived connection per
 * Mail Account with anything idle-and-changed to export, independent of the
 * resident IDLE session — a slow Drafts push should never stall INBOX
 * IDLE, and vice versa. `main.ts` is the only real caller.
 */

/**
 * Ticks well inside the 30s idle window (`DRAFT_PUSH_IDLE_MS`) so a
 * Composition that just crossed it gets exported within a few seconds of
 * going idle, not up to another 30s late.
 */
const DEFAULT_INTERVAL_MS = 10_000;

export interface DraftPushLoopOptions {
  mailCredentialKey: string;
  intervalMs?: number;
  logger?: FastifyBaseLogger;
}

export interface DraftPushLoopHandle {
  stop(): Promise<void>;
}

export function startDraftPushLoop(
  db: Db,
  { mailCredentialKey, intervalMs = DEFAULT_INTERVAL_MS, logger }: DraftPushLoopOptions,
): DraftPushLoopHandle {
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
      accountIds = await accountsWithPendingDrafts(db);
    } catch (err) {
      logger?.error({ err }, "draft push loop: failed to list pending accounts");
      return;
    }
    for (const accountId of accountIds) {
      if (stopped) return;
      try {
        await pushAccount(db, accountId, credentialKey, logger);
      } catch (err) {
        logger?.error({ err, accountId }, "draft push loop: push failed");
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

/** Every Mail Account with at least one idle, unpushed-at-its-current-content Draft. */
async function accountsWithPendingDrafts(db: Db): Promise<string[]> {
  const cutoff = new Date(Date.now() - DRAFT_PUSH_IDLE_MS);
  const rows = await db
    .selectDistinct({ mailAccountId: compositions.mailAccountId })
    .from(compositions)
    .where(and(eq(compositions.status, "draft"), lte(compositions.updatedAt, cutoff)));
  return rows.map((row) => row.mailAccountId);
}

async function pushAccount(
  db: Db,
  mailAccountId: string,
  credentialKey: Buffer,
  logger: FastifyBaseLogger | undefined,
): Promise<void> {
  const account = await getMailAccountById(db, mailAccountId);
  // Gone, or Needs Reauth (CONTEXT.md: syncing stops until credentials are
  // re-entered) — either way there is nothing to connect with, and the
  // failed push stays silent (ADR-0012), simply retried on a later tick.
  if (!account || account.status === "needs_reauth") return;

  const result = await withMailAccountConnection(db, account, { credentialKey }, (client) =>
    pushDraftsForAccount(db, client, mailAccountId, account.emailAddress),
  );
  if (result.skippedNoFolder) {
    logger?.debug({ mailAccountId }, "draft push loop: no Drafts folder on this account");
  }
}
