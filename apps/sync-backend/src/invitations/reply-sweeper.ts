import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type ImipReplyRow, imipReplies } from "../db/schema.js";
import { isGmailAccount } from "../mail-accounts/server-kind.js";
import { type MailAccountRow, markNeedsReauth } from "../mail-accounts/store.js";
import { recordMailFacetNeedsReauthNotification } from "../notifier/record.js";
import { findFolderByRole } from "../sync/folders.js";
import { withMailAccountConnection } from "../sync/imap-connection.js";
import {
  claimReply,
  dueReplyCandidateIds,
  markReplyPermanentFailure,
  markReplySent,
  releaseReplyForReauth,
  scheduleReplyRetry,
} from "./local-answer.js";
import { type SendMail, submitImipReply } from "./reply-submit.js";

/**
 * The `imip_replies` sweeper (#241, ADR-0027) — `compose/send-sweeper.ts`'s
 * own shape, claim/submit/APPEND, minus the Composition-only bookkeeping
 * (draft expunge, blob cleanup, Correspondent activity, Gatekeeper
 * approval) that has no counterpart for a `REPLY` sent to an organiser the
 * User did not choose to correspond with.
 */

export interface ReplySweepOptions {
  credentialKey: Buffer;
  sendMail?: SendMail;
  appendToSent?: AppendReplyToSent;
  now?: Date;
  logger?: FastifyBaseLogger;
}

export type AppendReplyToSent = (args: {
  account: MailAccountRow;
  row: ImipReplyRow;
  mime: Buffer;
}) => Promise<void>;

export interface ReplySweepResult {
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  held: number;
}

function mintMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1] ?? "mail.invalid";
  return `${randomUUID()}@${domain}`;
}

export async function sweepOneReply(
  db: Db,
  account: MailAccountRow,
  replyId: string,
  options: ReplySweepOptions,
): Promise<"sent" | "failed" | "retried" | "held" | "skipped"> {
  const now = options.now ?? new Date();
  if (account.status === "needs_reauth") return "held";

  const row = await claimReply(db, replyId, () => mintMessageId(account.emailAddress), now);
  if (!row) return "skipped";

  const result = await submitImipReply(account, row, {
    credentialKey: options.credentialKey,
    sendMail: options.sendMail,
    now,
  });

  if (!result.ok) {
    if (result.kind === "reauth") {
      const transitioned = await markNeedsReauth(db, account.id);
      if (transitioned) await recordMailFacetNeedsReauthNotification(db, transitioned);
      await releaseReplyForReauth(db, row, now);
      options.logger?.warn(
        { mailAccountId: account.id, replyId },
        "iMIP REPLY held: Mail Account needs reauth",
      );
      return "held";
    }
    if (result.kind === "permanent") {
      await markReplyPermanentFailure(db, row.id, result.detail, now);
      return "failed";
    }
    const { retrying } = await scheduleReplyRetry(db, row, result.detail, now);
    return retrying ? "retried" : "failed";
  }

  try {
    const append = options.appendToSent ?? imapSentWriterForReply(db, options.credentialKey);
    await append({ account, row, mime: result.mime });
  } catch (err) {
    options.logger?.error(
      { err, mailAccountId: account.id, replyId },
      "iMIP REPLY sent, but writing it to Sent failed",
    );
  }
  await markReplySent(db, row.id, now);
  return "sent";
}

/** `APPEND` to the account's `Sent` folder — `compose/send-sweeper.ts#imapSentWriter`'s own shape and same Gmail exception (ADR-0020, #123): Gmail files its own SMTP-submitted copy into Sent, so a second APPEND is skipped. */
export function imapSentWriterForReply(db: Db, credentialKey: Buffer): AppendReplyToSent {
  return async ({ account, mime }) => {
    if (isGmailAccount(account.serverKind)) return;
    await withMailAccountConnection(db, account, { credentialKey }, async (client) => {
      const sent = await findFolderByRole(db, account.id, "sent");
      if (!sent) return;
      const lock = await client.getMailboxLock(sent.path);
      try {
        await client.append(sent.path, mime, ["\\Seen"]);
      } finally {
        lock.release();
      }
    });
  };
}

export async function sweepDueReplies(
  db: Db,
  loadAccount: (mailAccountId: string) => Promise<MailAccountRow | null>,
  options: ReplySweepOptions,
): Promise<ReplySweepResult> {
  const now = options.now ?? new Date();
  const ids = await dueReplyCandidateIds(db, now);
  const result: ReplySweepResult = { processed: 0, sent: 0, failed: 0, retried: 0, held: 0 };
  if (ids.length === 0) return result;

  const accounts = new Map<string, MailAccountRow | null>();
  for (const id of ids) {
    const [row] = await db
      .select({ mailAccountId: imipReplies.mailAccountId })
      .from(imipReplies)
      .where(eq(imipReplies.id, id))
      .limit(1);
    if (!row) continue;
    if (!accounts.has(row.mailAccountId)) {
      accounts.set(row.mailAccountId, await loadAccount(row.mailAccountId));
    }
    const account = accounts.get(row.mailAccountId);
    if (!account) continue;

    const outcome = await sweepOneReply(db, account, id, { ...options, now });
    if (outcome === "skipped") continue;
    result.processed += 1;
    if (outcome === "sent") result.sent += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "retried") result.retried += 1;
    else result.held += 1;
  }
  return result;
}
