import { normalizeSenderAddress } from "@mail/shared";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import type { FolderRow } from "../sync/folders.js";
import { enqueueProtocolWrites } from "../sync/protocol-writes.js";
import { resolveVerdicts, verdictFor } from "./verdicts.js";

/**
 * The screening gate (#55, poc-spec.md §Gatekeeper v1, ADR-0008): what
 * Gatekeeper does to a batch of messages that has *just arrived* on a live
 * Mail Account.
 *
 * The hold rule is four conjunctions and poc-spec.md states all four:
 * a message is held only if it **starts a new Thread**, is in the **Inbox**,
 * arrived **after the Cutoff**, and comes from an **Unscreened Sender**.
 * Each one is load-bearing:
 *
 * - *starts a new Thread* is what makes a reply in an ongoing conversation
 *   never get held, however the correspondent stands — screening is about
 *   strangers walking up, not about mail you are already having.
 * - *in the Inbox* keeps a Sent self-copy, a Junk delivery, and anything a
 *   server-side rule already filed out of the Screener's way.
 * - *after the Cutoff* is the grandfathering promise (CONTEXT.md's Gatekeeper
 *   Cutoff): day one of screening shows an empty Screener, not a backlog of
 *   every stranger in mailbox history.
 * - *Unscreened* is the Verdict itself, resolved address-beats-domain by
 *   `gatekeeper/verdicts.ts`.
 *
 * This only ever runs from the two **live** arrival paths (`sync/delta.ts`,
 * `sync/qresync-catchup.ts`), never from backfill — the same "which
 * functions call it" contract `notifier/record.ts` documents for itself, and
 * for the same reason: a backfill walking a fifteen-year mailbox must not
 * screen anything, because everything it finds predates the Cutoff by
 * definition.
 */

/** A sender named in the Gatekeeper digest — the display name if the mail carried one, else the address. */
export interface HeldSender {
  address: string;
  name: string | null;
}

export interface ScreeningResult {
  /** Threads newly put on hold by this batch. */
  heldMessageIds: string[];
  /** Messages from a Blocked Sender: `\Trash` on arrival (ADR-0008). */
  blockedMessageIds: string[];
  /**
   * What is still eligible for a `new_mail` push — everything that was
   * neither held nor blocked, and did not land in a Thread that was already
   * being held. The Notifier reads this instead of re-deciding: ADR-0015's
   * "push-worthy is Approved-Sender Inbox mail" and this gate are the same
   * judgement, and having two of them would eventually disagree.
   */
  notifiableMessageIds: string[];
  /** Distinct senders newly held by this batch, for the coalesced digest push (poc-scope.md). */
  newlyHeldSenders: HeldSender[];
}

function passThrough(createdMessageIds: string[]): ScreeningResult {
  return {
    heldMessageIds: [],
    blockedMessageIds: [],
    notifiableMessageIds: createdMessageIds,
    newlyHeldSenders: [],
  };
}

export async function screenArrivals(
  db: Db,
  folder: Pick<FolderRow, "id" | "mailAccountId" | "role">,
  account: Pick<MailAccountRow, "id" | "gatekeeperEnabled" | "gatekeeperCutoff">,
  createdMessageIds: string[],
): Promise<ScreeningResult> {
  if (createdMessageIds.length === 0) return passThrough(createdMessageIds);
  // Opt-in per Mail Account (CONTEXT.md). Off is the default and the only
  // state an account has before the User ever visits Settings, so this is
  // the hot path — it costs one boolean, not a query.
  if (!account.gatekeeperEnabled) return passThrough(createdMessageIds);
  // Enabled with no Cutoff should be impossible (`settings.ts` writes both
  // in one statement), but "no Cutoff" can only mean "screen everything
  // ever", which is the one outcome grandfathering exists to prevent.
  if (!account.gatekeeperCutoff) return passThrough(createdMessageIds);

  const arrivals = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      receivedAt: messages.receivedAt,
    })
    .from(messages)
    .where(inArray(messages.id, createdMessageIds))
    // Oldest first, so that when one batch carries a stranger's opening
    // message *and* their own follow-up, the opener is the one that starts
    // the Thread and the follow-up joins an already-held Thread.
    .orderBy(asc(messages.receivedAt));
  if (arrivals.length === 0) return passThrough(createdMessageIds);

  const resolved = await resolveVerdicts(
    db,
    account.id,
    arrivals.map((arrival) => arrival.fromAddress ?? ""),
  );

  const threadIds = [...new Set(arrivals.map((arrival) => arrival.threadId))];
  const alreadyHeld = new Map<string, string | null>(
    (
      await db
        .select({ id: threads.id, heldSender: threads.heldSender })
        .from(threads)
        .where(inArray(threads.id, threadIds))
    ).map((row) => [row.id, row.heldSender]),
  );

  // "Starts a new Thread" as this mailbox can actually observe it: the
  // Thread holds nothing but the messages that just arrived. Threading is
  // reference-based and order-independent (`sync/threading.ts`), so a reply
  // whose parent this account has never stored genuinely *is* a new Thread
  // here, and treating it as one is right — the User has no conversation to
  // recognize it from either.
  const preexisting = new Map<string, number>(
    (
      await db
        .select({ threadId: messages.threadId, total: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(inArray(messages.threadId, threadIds), notInArray(messages.id, createdMessageIds)),
        )
        .groupBy(messages.threadId)
    ).map((row) => [row.threadId, row.total]),
  );

  const result: ScreeningResult = {
    heldMessageIds: [],
    blockedMessageIds: [],
    notifiableMessageIds: [],
    newlyHeldSenders: [],
  };
  const seenInBatch = new Map<string, number>();
  const heldSenderNames = new Map<string, string | null>();
  // Split by destination (#102): a plain Block moves to Trash, Spam to
  // Junk — the same distinction `gatekeeper/decisions.ts#trashHeldThreads`
  // draws for the Screener's own decisions, mirrored here for what a
  // *future* arrival from an already-decided sender does.
  const blockedByThread = new Map<string, string[]>();
  const spammedByThread = new Map<string, string[]>();

  for (const arrival of arrivals) {
    const batchSoFar = seenInBatch.get(arrival.threadId) ?? 0;
    seenInBatch.set(arrival.threadId, batchSoFar + 1);

    const address = arrival.fromAddress;
    const resolvedVerdict = verdictFor(resolved, address);
    const verdict = resolvedVerdict.verdict;

    if (verdict === "blocked" && folder.role === "inbox") {
      result.blockedMessageIds.push(arrival.id);
      const byThread = resolvedVerdict.spam ? spammedByThread : blockedByThread;
      const bucket = byThread.get(arrival.threadId) ?? [];
      bucket.push(arrival.id);
      byThread.set(arrival.threadId, bucket);
      continue;
    }

    // A Thread that is already held stays held, and nothing inside it
    // notifies — the stranger following up on their own unanswered opener is
    // still the same one decision waiting in the Screener.
    if (alreadyHeld.get(arrival.threadId)) continue;

    const startsNewThread = (preexisting.get(arrival.threadId) ?? 0) === 0 && batchSoFar === 0;
    const shouldHold =
      startsNewThread &&
      folder.role === "inbox" &&
      verdict === "unscreened" &&
      address !== null &&
      // `>=`, not `>` — see `gatekeeper/settings.ts#flooredToSecond` for why
      // the Cutoff is second-granular and which way this rounds.
      arrival.receivedAt >= account.gatekeeperCutoff;

    if (!shouldHold) {
      result.notifiableMessageIds.push(arrival.id);
      continue;
    }

    const normalized = normalizeSenderAddress(address);
    await db
      .update(threads)
      .set({ heldSender: normalized, heldAt: new Date() })
      .where(eq(threads.id, arrival.threadId));
    alreadyHeld.set(arrival.threadId, normalized);
    result.heldMessageIds.push(arrival.id);
    if (!heldSenderNames.has(normalized)) {
      heldSenderNames.set(normalized, arrival.fromName?.trim() || null);
    }
  }

  for (const [threadId, messageIds] of blockedByThread) {
    await moveOnArrival(db, account.id, threadId, messageIds, "trash");
  }
  for (const [threadId, messageIds] of spammedByThread) {
    await moveOnArrival(db, account.id, threadId, messageIds, "junk");
  }

  result.newlyHeldSenders = [...heldSenderNames].map(([address, name]) => ({ address, name }));
  return result;
}

/**
 * ADR-0008's narrow exception, applied: a real IMAP move to the account's
 * `\Trash` (a plain Block) or `\Junk` (Spam, #102's amendment), visible to
 * every other client against the same mailbox.
 *
 * The move rides the existing write-through outbox (`sync/protocol-writes.ts`)
 * rather than reaching for the arriving connection directly. That is what
 * makes it durable and retried — the IDLE session that noticed the arrival
 * may drop before a `MOVE` could complete, and a block that silently failed
 * to move anything is worse than one that lands three seconds late. The
 * Thread drops out of the Inbox synchronously here, exactly as an
 * `archive`/`trash` intent does (`sync/mutations.ts`), so the mail never
 * surfaces in a Client while the move is still queued.
 *
 * `inInbox` is only flipped when nothing *else* of the Thread is left in the
 * Inbox: a Blocked or Spam sender replying into a conversation the User is
 * having with other people moves their message, not the conversation.
 */
async function moveOnArrival(
  db: Db,
  mailAccountId: string,
  threadId: string,
  messageIds: string[],
  target: "trash" | "junk",
): Promise<void> {
  await enqueueProtocolWrites(db, mailAccountId, messageIds, target);

  const stillInInbox = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(folders, eq(messages.folderId, folders.id))
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(folders.role, "inbox"),
        notInArray(messages.id, messageIds),
      ),
    )
    .limit(1);
  if (stillInInbox.length > 0) return;

  await db
    .update(threads)
    .set({ inInbox: false, folderRole: target })
    .where(eq(threads.id, threadId));
}
