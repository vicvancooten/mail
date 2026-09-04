import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, mailAccounts, messages, protocolWrites, threads } from "../db/schema.js";
import type { MailAccountServerKind } from "../mail-accounts/server-kind.js";
import type { FolderRole } from "./folders.js";
import { isInInbox } from "./inbox.js";
import { enqueueProtocolWrites } from "./protocol-writes.js";

/**
 * Undo's own real inverse of `archive`/`trash`/`spamSender` (#95, ADR-0019)
 * — a leaf module rather than living in `sync/mutations.ts` or
 * `gatekeeper/decisions.ts` so either can call it without the two importing
 * each other. Moves whatever of these Threads' Messages currently sit in
 * Archive/Trash/Junk back to the account's Inbox over real IMAP, and flips
 * the Thread row back synchronously — the same "ack before the real MOVE
 * lands" shape `sync/mutations.ts`'s own `archive`/`trash` branch gives the
 * opposite direction.
 *
 * Also clears `heldSender`/`heldRecipientAlias`/`heldAt`:
 * `gatekeeper/decisions.ts#unblockAndRestore` (Undo's own inverse of Deny,
 * Block, Spam, and #103's Block-Alias) calls this on Threads a Screener
 * decision trashed or spammed, and restoring them to the Inbox — never back
 * into the Screener's hold — is exactly what a Screener Approve already
 * does to a held Thread (`releaseHeldThreads`), just reusing the *IMAP* half
 * of that effect too, since these were actually moved out. A no-op for the
 * ordinary `restoreToInbox` intent, whose Thread never held anything.
 *
 * Threads named that don't belong to `mailAccountId` are silently dropped —
 * the same tolerance `sync/mutations.ts` gives a stale/foreign `threadId`
 * elsewhere — rather than failing the whole batch over one bad id.
 *
 * Runs inside one transaction with the write-through outbox cancellation
 * below, so a concurrent `drainProtocolWrites` pass either wins the race
 * outright (its `MOVE` already landed, and the "resident" query below finds
 * and reverses it) or loses it cleanly (its still-queued row is deleted out
 * from under it before it ever opens a connection) — never the third,
 * previously possible outcome where the Thread row says "inbox" while a
 * `trash`/`archive`/`junk` write it never saw coming still drains later.
 */
export async function restoreThreadsToInbox(
  db: Db,
  mailAccountId: string,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;

  await db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(inArray(threads.id, threadIds), eq(threads.mailAccountId, mailAccountId)));
    const ownedIds = owned.map((row) => row.id);
    if (ownedIds.length === 0) return;

    const threadMessages = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.threadId, ownedIds));
    const messageIds = threadMessages.map((row) => row.id);

    // Cancel whatever of this restore's own Messages are still sitting
    // un-drained in the write-through outbox (ADR-0019) — the exact
    // `archive`/`trash`/`junk` MOVE this restore exists to undo, queued by
    // `sync/mutations.ts`'s or `gatekeeper/decisions.ts`'s synchronous ack
    // but not yet applied by `drainProtocolWrites`. Left queued, the drain
    // loop would apply it *after* the Thread update below already says
    // "inbox" — a real IMAP move to Trash/Junk the Client never asked for
    // again, with the User's Undo silently discarded by the very flush it
    // was racing. Deleting it here is not the "cancel a queued original"
    // ADR-0019 forbids for Undo itself — this restore *is* Undo's real
    // inverse, already committed; cancelling a write that inverse has just
    // superseded is the ordinary "a newer decision wins" every other
    // Optimistic Action already gets, not a new kind of shortcut.
    if (messageIds.length > 0) {
      await tx
        .delete(protocolWrites)
        .where(
          and(
            inArray(protocolWrites.messageId, messageIds),
            inArray(protocolWrites.kind, ["archive", "trash", "junk"]),
          ),
        );
    }

    // Whatever already made it out of the outbox and onto real IMAP — the
    // drain won the race, or simply ran a while ago — gets the opposite
    // effect, same as before. `"junk"` joins `"archive"`/`"trash"` here for
    // Spam (#102): `unblockAndRestore` rides this same step to undo a
    // `spamSender` decision, and a Thread's Messages already moved to Junk
    // need exactly the same "back to Inbox" treatment the other two do.
    //
    // On Gmail (#124, ADR-0020) a Done archive never moved anything, so
    // `isRestoreCandidate` reads through `sync/inbox.ts#isInInbox` instead of
    // a bare Folder-role check: a Message still sitting in All Mail without
    // `\Inbox` is exactly as much "needs restoring" as one a generic
    // account's `archive` intent actually moved. Both land the same "inbox"
    // outbox kind either way — `protocol-writes.ts`'s own drain is what
    // reads a fresh `folderRole` and picks a label-add or a real move back.
    const [accountRow] = await tx
      .select({ serverKind: mailAccounts.serverKind })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, mailAccountId))
      .limit(1);
    const serverKind: MailAccountServerKind | null = accountRow?.serverKind ?? null;

    const candidates = await tx
      .select({ id: messages.id, folderRole: folders.role, gmailLabels: messages.gmailLabels })
      .from(messages)
      .innerJoin(folders, eq(messages.folderId, folders.id))
      .where(inArray(messages.threadId, ownedIds));
    const resident = candidates.filter((row) =>
      isRestoreCandidate(serverKind, row.folderRole, row.gmailLabels),
    );
    await enqueueProtocolWrites(
      tx,
      mailAccountId,
      resident.map((row) => row.id),
      "inbox",
    );

    await tx
      .update(threads)
      .set({
        inInbox: true,
        folderRole: "inbox",
        heldSender: null,
        heldAt: null,
        heldRecipientAlias: null,
      })
      .where(inArray(threads.id, ownedIds));
  });
}

/**
 * Mirrors `protocol-writes.ts#isAlreadyApplied`'s own precedence: Trash/Junk
 * role wins outright, on every server — Gmail keeps labels on a
 * trashed/spammed message (`sync/inbox.ts`'s own doc comment), so a stale
 * `\Inbox` label must never read as "nothing to restore" there. Everywhere
 * else is judged by `isInInbox`: a generic account's real Archive Folder, or
 * a Gmail All Mail copy the Done label removal left without `\Inbox`.
 */
function isRestoreCandidate(
  serverKind: MailAccountServerKind | null,
  folderRole: FolderRole | null,
  gmailLabels: readonly string[] | null,
): boolean {
  if (folderRole === "trash" || folderRole === "junk") return true;
  if (serverKind === "gmail") return folderRole === "all" && !isInInbox(folderRole, gmailLabels);
  return folderRole === "archive";
}
