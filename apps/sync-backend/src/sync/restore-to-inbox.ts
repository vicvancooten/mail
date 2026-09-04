import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, messages, threads } from "../db/schema.js";
import { enqueueProtocolWrites } from "./protocol-writes.js";

/**
 * Undo's own real inverse of `archive`/`trash` (#95, ADR-0019) — a leaf
 * module rather than living in `sync/mutations.ts` or
 * `gatekeeper/decisions.ts` so either can call it without the two importing
 * each other. Moves whatever of these Threads' Messages currently sit in
 * Archive/Trash back to the account's Inbox over real IMAP, and flips the
 * Thread row back synchronously — the same "ack before the real MOVE lands"
 * shape `sync/mutations.ts`'s own `archive`/`trash` branch gives the
 * opposite direction.
 *
 * Also clears `heldSender`/`heldAt`: `gatekeeper/decisions.ts#unblockAndRestore`
 * (Undo's own inverse of Deny/Block) calls this on Threads a Screener
 * decision trashed, and restoring them to the Inbox — never back into the
 * Screener's hold — is exactly what a Screener Approve already does to a
 * held Thread (`releaseHeldThreads`), just reusing the *IMAP* half of that
 * effect too, since these were actually moved out. A no-op for the ordinary
 * `restoreToInbox` intent, whose Thread never held anything.
 *
 * Threads named that don't belong to `mailAccountId` are silently dropped —
 * the same tolerance `sync/mutations.ts` gives a stale/foreign `threadId`
 * elsewhere — rather than failing the whole batch over one bad id.
 */
export async function restoreThreadsToInbox(
  db: Db,
  mailAccountId: string,
  threadIds: string[],
): Promise<void> {
  if (threadIds.length === 0) return;

  const owned = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(inArray(threads.id, threadIds), eq(threads.mailAccountId, mailAccountId)));
  const ownedIds = owned.map((row) => row.id);
  if (ownedIds.length === 0) return;

  const resident = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(folders, eq(messages.folderId, folders.id))
    .where(and(inArray(messages.threadId, ownedIds), inArray(folders.role, ["archive", "trash"])));
  await enqueueProtocolWrites(
    db,
    mailAccountId,
    resident.map((row) => row.id),
    "inbox",
  );

  await db
    .update(threads)
    .set({ inInbox: true, folderRole: "inbox", heldSender: null, heldAt: null })
    .where(inArray(threads.id, ownedIds));
}
