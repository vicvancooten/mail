import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { type ImipRequestRow, imipRequests } from "../db/schema.js";
import { isGmailAccount } from "../mail-accounts/server-kind.js";
import { type MailAccountRow, markNeedsReauth } from "../mail-accounts/store.js";
import { recordMailFacetNeedsReauthNotification } from "../notifier/record.js";
import { findFolderByRole } from "../sync/folders.js";
import { withMailAccountConnection } from "../sync/imap-connection.js";
import {
  claimRequest,
  dueRequestCandidateIds,
  markRequestPermanentFailure,
  markRequestSent,
  releaseRequestForReauth,
  scheduleRequestRetry,
} from "./local-organizer.js";
import { type SendMail, submitImipRequest } from "./request-submit.js";

/**
 * The `imip_requests` sweeper (#242, ADR-0027) — `invitations/reply-sweeper
 * .ts`'s own shape, claim/submit/APPEND, one Attendee at a time.
 */

export interface RequestSweepOptions {
  credentialKey: Buffer;
  sendMail?: SendMail;
  appendToSent?: AppendRequestToSent;
  now?: Date;
  logger?: FastifyBaseLogger;
}

export type AppendRequestToSent = (args: {
  account: MailAccountRow;
  row: ImipRequestRow;
  mime: Buffer;
}) => Promise<void>;

export interface RequestSweepResult {
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

export async function sweepOneRequest(
  db: Db,
  account: MailAccountRow,
  requestId: string,
  options: RequestSweepOptions,
): Promise<"sent" | "failed" | "retried" | "held" | "skipped"> {
  const now = options.now ?? new Date();
  if (account.status === "needs_reauth") return "held";

  const row = await claimRequest(db, requestId, () => mintMessageId(account.emailAddress), now);
  if (!row) return "skipped";

  const result = await submitImipRequest(account, row, {
    credentialKey: options.credentialKey,
    sendMail: options.sendMail,
    now,
  });

  if (!result.ok) {
    if (result.kind === "reauth") {
      const transitioned = await markNeedsReauth(db, account.id);
      if (transitioned) await recordMailFacetNeedsReauthNotification(db, transitioned);
      await releaseRequestForReauth(db, row, now);
      options.logger?.warn(
        { mailAccountId: account.id, requestId },
        "iMIP organiser send held: Mail Account needs reauth",
      );
      return "held";
    }
    if (result.kind === "permanent") {
      await markRequestPermanentFailure(db, row.id, result.detail, now);
      return "failed";
    }
    const { retrying } = await scheduleRequestRetry(db, row, result.detail, now);
    return retrying ? "retried" : "failed";
  }

  try {
    const append = options.appendToSent ?? imapSentWriterForRequest(db, options.credentialKey);
    await append({ account, row, mime: result.mime });
  } catch (err) {
    options.logger?.error(
      { err, mailAccountId: account.id, requestId },
      "iMIP organiser send sent, but writing it to Sent failed",
    );
  }
  await markRequestSent(db, row.id, now);
  return "sent";
}

/** `APPEND` to the account's `Sent` folder — `reply-sweeper.ts#imapSentWriterForReply`'s own shape and Gmail exception (ADR-0020, #123). */
export function imapSentWriterForRequest(db: Db, credentialKey: Buffer): AppendRequestToSent {
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

export async function sweepDueRequests(
  db: Db,
  loadAccount: (mailAccountId: string) => Promise<MailAccountRow | null>,
  options: RequestSweepOptions,
): Promise<RequestSweepResult> {
  const now = options.now ?? new Date();
  const ids = await dueRequestCandidateIds(db, now);
  const result: RequestSweepResult = { processed: 0, sent: 0, failed: 0, retried: 0, held: 0 };
  if (ids.length === 0) return result;

  const accounts = new Map<string, MailAccountRow | null>();
  for (const id of ids) {
    const [row] = await db
      .select({ mailAccountId: imipRequests.mailAccountId })
      .from(imipRequests)
      .where(eq(imipRequests.id, id))
      .limit(1);
    if (!row) continue;
    if (!accounts.has(row.mailAccountId)) {
      accounts.set(row.mailAccountId, await loadAccount(row.mailAccountId));
    }
    const account = accounts.get(row.mailAccountId);
    if (!account) continue;

    const outcome = await sweepOneRequest(db, account, id, { ...options, now });
    if (outcome === "skipped") continue;
    result.processed += 1;
    if (outcome === "sent") result.sent += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "retried") result.retried += 1;
    else result.held += 1;
  }
  return result;
}
