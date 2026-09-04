import type { GatekeeperSender } from "@mail/shared";
import { normalizeGatekeeperSender } from "@mail/shared";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import { findFolderByRole } from "../sync/folders.js";
import { enqueueProtocolWrites } from "../sync/protocol-writes.js";
import { restoreThreadsToInbox } from "../sync/restore-to-inbox.js";
import { BarredVerdictDomainError, clearVerdict, setVerdict } from "./verdicts.js";

/**
 * The Screener's three decisions and the Blocked Senders list's undo (#55,
 * poc-spec.md §Gatekeeper v1). Each is applied by `sync/mutations.ts` as an
 * Optimistic Action — see `@mail/shared`'s `mutationIntentSchema` for why
 * they ride that queue.
 *
 * Every one of them acts on a **sender**, not a Thread: "the Screener lists
 * held *senders* ... one decision per stranger, not per message"
 * (poc-spec.md). So each resolves the sender to whatever Threads that sender
 * is currently holding and acts on all of them at once, which is also what
 * makes the decision correct for a stranger who wrote three times while
 * waiting.
 */

export type DecisionResult = { ok: true } | { ok: false; reason: string };

/**
 * Approve: release the held Threads and record an Approved Verdict. Their
 * `receivedAt` was never touched, so they land in the Inbox at their real
 * position in the list rather than bunched at the moment of approval —
 * poc-spec.md's "release, original dates", free by construction.
 *
 * The Verdict is also the image-loading permission from this moment on
 * (poc-scope.md: "the Gatekeeper verdict *is* the image-loading
 * permission") — `routes/messages.ts` reads it per message on every open.
 */
export async function approveSender(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
): Promise<DecisionResult> {
  return withVerdictWrite(async () => {
    await setVerdict(db, mailAccountId, sender, "approved", "screener");
    await releaseHeldThreads(db, mailAccountId, sender);
  });
}

/**
 * Deny: trash the held Threads and leave the sender **Unscreened**
 * (poc-spec.md). Not a Block — the next thing this sender sends is held
 * again, which is exactly right for the "no thanks, but I don't want to
 * commit" case the Screener sees most.
 *
 * Any Verdict already stored for this key is cleared, so Deny is also the
 * way an Approved sender who was approved by mistake goes back to being
 * screened. It stays true that "Block is the sole off-switch for an Approved
 * sender" in the sense poc-spec.md means it — Deny does not stop their mail
 * arriving, it just stops them being through the gate.
 */
export async function denySender(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
): Promise<DecisionResult> {
  return withVerdictWrite(async () => {
    await clearVerdict(db, mailAccountId, sender);
    await trashHeldThreads(db, mailAccountId, sender, "trash");
  });
}

/**
 * Block: trash the held Threads and record a Blocked Verdict, after which
 * every future arrival from this sender is moved to the account's real
 * `\Trash` on arrival (ADR-0008, `gatekeeper/screening.ts`).
 *
 * Retroactive only as far as the Screener: mail already released into the
 * Inbox stays there. ADR-0008's "unblocking is always future-only" has a
 * mirror here — blocking is future-only too, apart from the held Threads
 * this decision is answering.
 */
export async function blockSender(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
): Promise<DecisionResult> {
  return withVerdictWrite(async () => {
    await setVerdict(db, mailAccountId, sender, "blocked", "screener");
    await trashHeldThreads(db, mailAccountId, sender, "trash");
  });
}

/**
 * Spam (#102, CONTEXT.md, ADR-0008's amendment): everything `blockSender`
 * does, plus the one thing that makes it Spam rather than a plain Block —
 * the held Threads (and every future arrival, `gatekeeper/screening.ts`)
 * move to the Mail Account's Junk folder rather than Trash, so the
 * provider's own filter learns from it. Recorded as a Blocked Verdict with
 * `spam: true` (`verdicts.ts#setVerdict`) rather than a fourth Verdict value
 * — a Spam sender is Blocked for every other purpose a Verdict answers.
 *
 * The Screener's Block split menu offers this as a deliberate extra click
 * behind Block sender/Block domain, never the default — "I don't want this"
 * and "this is spam" are different claims, and only the User can tell them
 * apart.
 */
export async function spamSender(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
): Promise<DecisionResult> {
  return withVerdictWrite(async () => {
    await setVerdict(db, mailAccountId, sender, "blocked", "screener", true);
    await trashHeldThreads(db, mailAccountId, sender, "junk");
  });
}

/**
 * Unblock, from the Blocked Senders list in Settings. Clears the Verdict
 * back to Unscreened — not back to Approved, because the User never approved
 * this sender, they only stopped refusing them. The next thing that arrives
 * is held for a fresh decision.
 *
 * Recovers nothing: whatever was moved to Trash while the block stood is
 * still in Trash, and most servers purge it after ~30 days (ADR-0008).
 */
export async function unblockSender(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
): Promise<DecisionResult> {
  return withVerdictWrite(async () => {
    await clearVerdict(db, mailAccountId, sender);
  });
}

/**
 * Undo's own real inverse of Deny *and* Block (#95, ADR-0019) — never a
 * queue cancellation, so this reverses the decision whether or not
 * `denySender`/`blockSender` has already flushed. Clears the Verdict (a
 * no-op for Deny, which never set one) and restores exactly the Threads the
 * Client named — captured at decision time
 * (`ScreenerSenderGroup.threadIds`), since by the time Undo fires this
 * sender may be holding a fresh, unrelated stranger's mail again and
 * re-deriving "what did this decision trash" from the sender alone would
 * risk sweeping that up too.
 *
 * Restores to the Inbox, never back into the Screener's hold — the same
 * "release, don't re-ask" effect an Approve has, reusing its own
 * `restoreThreadsToInbox` step. A Thread already purged from Trash by the
 * mail server (ADR-0008: "most servers auto-purge Trash after ~30 days") is
 * a harmless no-op there — the Verdict still clears, which is all Undo can
 * promise past that point.
 */
export async function unblockAndRestore(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
  threadIds: string[],
): Promise<DecisionResult> {
  return withVerdictWrite(async () => {
    await clearVerdict(db, mailAccountId, sender);
    await restoreThreadsToInbox(db, mailAccountId, threadIds);
  });
}

/**
 * Turns a barred domain into a `rejected` outcome rather than a 500. The
 * Client should never have offered a domain button for a public provider, so
 * this is a stale-Client/mistaken-caller path, not a User-facing flow — but
 * a rejection is still the honest answer, and ADR-0010's queue already knows
 * how to stop retrying one.
 */
async function withVerdictWrite(apply: () => Promise<void>): Promise<DecisionResult> {
  try {
    await apply();
    return { ok: true };
  } catch (error) {
    if (error instanceof BarredVerdictDomainError) {
      return { ok: false, reason: "barred_verdict_domain" };
    }
    throw error;
  }
}

/**
 * Every Thread this sender is currently holding. An `address` decision
 * matches the held address exactly; a `domain` decision matches every held
 * address in that domain, which is the whole point of the overflow
 * convenience — one click for the twelve strangers a conference mailing list
 * just sent through.
 *
 * `like` with an escaped `@domain` suffix rather than a computed column: the
 * held set is a handful of rows behind a partial index (`db/schema.ts`), so
 * there is nothing here worth denormalizing a domain column for.
 */
function heldBySender(mailAccountId: string, sender: GatekeeperSender) {
  const normalized = normalizeGatekeeperSender(sender);
  return and(
    eq(threads.mailAccountId, mailAccountId),
    normalized.scope === "address"
      ? eq(threads.heldSender, normalized.value)
      : or(
          like(threads.heldSender, `%@${escapeLike(normalized.value)}`),
          // Belt and braces for a stored value that is itself a bare domain,
          // which nothing writes today but costs one comparison to tolerate.
          eq(threads.heldSender, normalized.value),
        ),
  );
}

/** Escapes the two `LIKE` wildcards so a domain containing `_` matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function releaseHeldThreads(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
): Promise<string[]> {
  const released = await db
    .update(threads)
    .set({ heldSender: null, heldAt: null })
    .where(heldBySender(mailAccountId, sender))
    .returning({ id: threads.id });
  return released.map((row) => row.id);
}

/**
 * Deny/Block/Spam's shared effect: the held Threads go to Trash (or, for
 * Spam, Junk — `target`), the same way an ordinary `trash` intent takes a
 * Thread to Trash (`sync/mutations.ts`) — the Thread leaves the Inbox
 * synchronously, and the real IMAP `MOVE` follows through the write-through
 * outbox. The hold is cleared in the same step, so a decided sender never
 * leaves a ghost row behind in the Screener.
 *
 * An account with no matching folder still gets the hold cleared and the
 * Thread out of the Inbox: the decision the User made is recorded either
 * way, and `sync/protocol-writes.ts` has nothing to move it to. That is the
 * one place this differs from the `trash` intent, which rejects outright — a
 * rejected Screener decision would leave the stranger sitting there with no
 * way for the User to make it stick.
 */
async function trashHeldThreads(
  db: Db,
  mailAccountId: string,
  sender: GatekeeperSender,
  target: "trash" | "junk",
): Promise<void> {
  const held = await db
    .select({ id: threads.id })
    .from(threads)
    .where(heldBySender(mailAccountId, sender));
  if (held.length === 0) return;
  const heldThreadIds = held.map((row) => row.id);

  const targetFolder = await findFolderByRole(db, mailAccountId, target);
  if (targetFolder) {
    const inboxResident = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(folders, eq(messages.folderId, folders.id))
      .where(and(inArray(messages.threadId, heldThreadIds), eq(folders.role, "inbox")));
    await enqueueProtocolWrites(
      db,
      mailAccountId,
      inboxResident.map((row) => row.id),
      target,
    );
  }

  await db
    .update(threads)
    .set({ heldSender: null, heldAt: null, inInbox: false, folderRole: target })
    .where(inArray(threads.id, heldThreadIds));
}
