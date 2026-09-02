import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { type CompositionRow, compositions } from "../db/schema.js";
import { approveSendRecipients } from "../gatekeeper/verdicts.js";
import { type MailAccountRow, markNeedsReauth } from "../mail-accounts/store.js";
import { recordFailedSendNotification, recordNeedsReauthNotification } from "../notifier/record.js";
import { activityForSentComposition, recordCorrespondentActivity } from "../sync/correspondents.js";
import { findFolderByRole } from "../sync/folders.js";
import { withMailAccountConnection } from "../sync/imap-connection.js";
import { deleteBlobsForComposition } from "./blob-store.js";
import {
  claimSend,
  dueSendCandidateIds,
  markPermanentFailure,
  markSent,
  mintMessageId,
  releaseForReauth,
  scheduleRetry,
} from "./pending-send.js";
import { type SendMail, submitComposition } from "./submit.js";

/**
 * The Pending Send sweeper (ADR-0007, #46): claims every due Composition,
 * hands it to SMTP, and — only on success — writes it into the account's
 * `Sent` folder and expunges the draft copy in the same step (ADR-0012's
 * lifecycle). `compose/send-loop.ts` is the interval that calls this;
 * everything about *when* to sweep lives there and everything about *what a
 * sweep does* lives here.
 *
 * "Nothing is written to `Sent` until submission succeeds" (ADR-0007) is
 * literal: the APPEND happens after `submitComposition` returns ok, never
 * before, so a cancelled or failed send leaves no trace in the User's
 * mailbox.
 */

export interface SweepOptions {
  credentialKey: Buffer;
  /** Injected by tests to stand in for a mail server (`compose/submit.ts`). */
  sendMail?: SendMail;
  /** Injected by tests so the `Sent` APPEND can be observed without a real IMAP server. */
  appendToSent?: AppendToSent;
  now?: Date;
  logger?: FastifyBaseLogger;
}

export type AppendToSent = (args: {
  account: MailAccountRow;
  row: CompositionRow;
  mime: Buffer;
}) => Promise<void>;

export interface SweepResult {
  /** Rows this sweep reached a verdict on — a lost claim is not one of them. */
  processed: number;
  sent: number;
  failed: number;
  retried: number;
  held: number;
}

/**
 * Sweeps one due Composition end to end. Split out from `sweepDueSends` so
 * the loop can be tested a row at a time, and so a single mail's failure can
 * never abandon the rest of the sweep.
 *
 * A Mail Account in Needs Reauth is declined **before** the claim: ADR-0007
 * holds its Pending Sends indefinitely, and claiming one only to release it
 * would burn an attempt and churn the row's `sync_rev` on every tick.
 */
export async function sweepOne(
  db: Db,
  account: MailAccountRow,
  compositionId: string,
  options: SweepOptions,
): Promise<"sent" | "failed" | "retried" | "held" | "skipped"> {
  const now = options.now ?? new Date();
  if (account.status === "needs_reauth") return "held";

  const row = await claimSend(db, compositionId, () => mintMessageId(account.emailAddress), now);
  // Lost the claim: cancelled a moment ago, or another tick took it. Not
  // this sweep's mail.
  if (!row) return "skipped";

  const result = await submitComposition(db, account, row, {
    credentialKey: options.credentialKey,
    sendMail: options.sendMail,
    now,
  });

  if (!result.ok) {
    if (result.kind === "reauth") {
      const transitioned = await markNeedsReauth(db, account.id);
      if (transitioned) await recordNeedsReauthNotification(db, transitioned);
      await releaseForReauth(db, row, now);
      options.logger?.warn(
        { mailAccountId: account.id, compositionId },
        "send held: Mail Account needs reauth",
      );
      return "held";
    }
    if (result.kind === "permanent") {
      await markPermanentFailure(db, row.id, result.detail, now);
      await recordFailedSendNotification(db, account, row, result.detail);
      return "failed";
    }
    const { retrying } = await scheduleRetry(db, row, result.detail, now);
    return retrying ? "retried" : "failed";
  }

  // The mail is out. Everything below is bookkeeping the User's mailbox
  // wants but the recipient has already stopped depending on — a failure
  // here must never re-send, which is why `markSent` runs regardless of
  // whether the IMAP half worked.
  try {
    const append = options.appendToSent ?? imapSentWriter(db, options.credentialKey);
    await append({ account, row, mime: result.mime });
  } catch (err) {
    options.logger?.error(
      { err, mailAccountId: account.id, compositionId },
      "message sent, but writing it to Sent (or expunging the draft copy) failed",
    );
  }
  await markSent(db, row.id, now);

  // Correspondent activity (#49, compose-spec: "built incrementally at
  // ingest and at send") — recorded here, the instant the send is
  // confirmed, so a brand-new recipient ranks/appears immediately rather
  // than waiting for the `Sent` copy to round-trip through the ordinary
  // IMAP poll. `sync/ingest.ts#storeMessage`'s own `wasRecordedAtSend`
  // check is what stops that later poll from double-counting this same
  // send. Best-effort, matching `approveSendRecipients` below: the mail is
  // already out, and a Correspondent row that failed to update is a ranking
  // gap, not a lost message.
  try {
    await recordCorrespondentActivity(
      db,
      account.id,
      activityForSentComposition(
        {
          toAddresses: row.toAddresses,
          ccAddresses: row.ccAddresses,
          bccAddresses: row.bccAddresses,
        },
        now,
      ),
    );
  } catch (err) {
    options.logger?.warn(
      { err, mailAccountId: account.id, compositionId },
      "message sent, but recording Correspondent activity failed",
    );
  }

  // "Sending approves live" (poc-spec.md §Gatekeeper v1, #55). Deliberately
  // here and not at `acceptSend`: a send that was cancelled inside the Undo
  // Send window, or that SMTP permanently rejected, is not a conversation
  // the User started, and approving off it would let a typo'd address
  // through the Screener forever. Best-effort — the mail is already out, and
  // a Verdict that failed to be written is a stranger held once more, not a
  // lost message.
  try {
    await approveSendRecipients(
      db,
      account.id,
      [...row.toAddresses, ...row.ccAddresses, ...row.bccAddresses].map(
        (recipient) => recipient.address,
      ),
    );
  } catch (err) {
    options.logger?.warn(
      { err, mailAccountId: account.id, compositionId },
      "message sent, but approving its recipients with Gatekeeper failed",
    );
  }
  return "sent";
}

/**
 * `APPEND` to the account's `Sent` folder, expunge the IMAP draft copy, and
 * drop the Composition's attachment blobs — all three over one connection
 * this function owns, in the same step (ADR-0012's lifecycle: "blobs are
 * deleted once the `Sent` `APPEND` succeeds, and the IMAP draft copy is
 * expunged in that same step").
 *
 * Folder discovery degrades rather than creates, exactly as the draft push
 * does: an account with no `Sent` folder simply gets no copy, and Mail never
 * creates a folder on the User's mail server as a side effect.
 *
 * This is `sweepOne`'s default, behind the `appendToSent` seam so a test can
 * exercise a whole sweep — claim, submit, failure classification — without
 * an IMAP server, while production still gets one connection per swept
 * message and no leaked sockets.
 */
export function imapSentWriter(db: Db, credentialKey: Buffer): AppendToSent {
  return async ({ account, row, mime }) => {
    await withMailAccountConnection(db, account, { credentialKey }, async (client) => {
      const sent = await findFolderByRole(db, account.id, "sent");
      if (sent) {
        const lock = await client.getMailboxLock(sent.path);
        try {
          await client.append(sent.path, mime, ["\\Seen"]);
        } finally {
          lock.release();
        }
      }
      await expungeDraftCopy(db, client, row);
    });
    await deleteBlobsForComposition(db, row.id);
  };
}

/**
 * Drops the Composition's own copy from `Drafts`. Guarded by the same "one
 * UID per Composition" rule the push uses (ADR-0012): only the UID this
 * Composition owns is ever deleted, and a UID that no longer resolves is
 * left alone rather than guessed at.
 */
async function expungeDraftCopy(db: Db, client: ImapFlow, row: CompositionRow): Promise<void> {
  if (row.imapDraftUid === null) return;
  const drafts = await findFolderByRole(db, row.mailAccountId, "drafts");
  if (!drafts) return;
  const lock = await client.getMailboxLock(drafts.path);
  try {
    await client.messageDelete(String(row.imapDraftUid), { uid: true }).catch(() => undefined);
  } finally {
    lock.release();
  }
  await db
    .update(compositions)
    .set({ imapDraftUid: null, pushedContentHash: null })
    .where(eq(compositions.id, row.id));
}

/**
 * One full sweep across every Mail Account on the instance. Due rows are
 * looked up once, then grouped by account so a `loadAccount` lookup is one
 * query per account rather than one per message.
 */
export async function sweepDueSends(
  db: Db,
  loadAccount: (mailAccountId: string) => Promise<MailAccountRow | null>,
  options: SweepOptions,
): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const ids = await dueSendCandidateIds(db, now);
  const result: SweepResult = { processed: 0, sent: 0, failed: 0, retried: 0, held: 0 };
  if (ids.length === 0) return result;

  const accounts = new Map<string, MailAccountRow | null>();
  for (const id of ids) {
    const [row] = await db
      .select({ mailAccountId: compositions.mailAccountId })
      .from(compositions)
      .where(eq(compositions.id, id))
      .limit(1);
    if (!row) continue;
    if (!accounts.has(row.mailAccountId)) {
      accounts.set(row.mailAccountId, await loadAccount(row.mailAccountId));
    }
    const account = accounts.get(row.mailAccountId);
    if (!account) continue;

    const outcome = await sweepOne(db, account, id, { ...options, now });
    if (outcome === "skipped") continue;
    result.processed += 1;
    if (outcome === "sent") result.sent += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "retried") result.retried += 1;
    else result.held += 1;
  }
  return result;
}
