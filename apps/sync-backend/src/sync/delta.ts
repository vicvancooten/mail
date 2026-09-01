import { eq, inArray } from "drizzle-orm";
import type { FetchMessageObject, ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { folders, messages } from "../db/schema.js";
import type { FolderRow } from "./folders.js";
import { applyUidValidity, ingestFolder, storeMessage } from "./ingest.js";
import { refreshThreadRollups } from "./thread-rollup.js";
import { deleteEmptyThreads } from "./threading.js";

/**
 * The UID-diff fallback (#35): reconciles one folder against the server by
 * comparing the full current UID+flags listing to what is stored, rather
 * than trusting any incremental signal. This is what runs whenever QRESYNC
 * is unavailable (`qresync-catchup.ts` returns `null`) — GreenMail's
 * capability findings (docs/dev-setup.md, this ticket) are exactly that: no
 * CONDSTORE, no QRESYNC, so this is the path every GreenMail-backed test
 * exercises.
 *
 * It is also what a QRESYNC-capable server's live IDLE session falls back
 * to for a mailbox whose baseline is stale for any other reason: correct
 * before cheap. A full UID+FLAGS listing is proportional to message count
 * with no envelope/bodystructure attached, so it stays affordable at the
 * PoC's scale even run on every wake.
 */

export interface FolderDeltaResult {
  folderId: string;
  created: number;
  updated: number;
  vanished: number;
  /** True when UIDVALIDITY had changed and the folder was rebuilt via a full ingest instead. */
  rebuilt: boolean;
}

/** Reused by `sync/qresync-catchup.ts` for a plain `>` comparison it does not have to duplicate. */
export function flagsDiffer(stored: string[], live: Set<string>): boolean {
  if (stored.length !== live.size) return true;
  for (const flag of stored) {
    if (!live.has(flag)) return true;
  }
  return false;
}

export async function applyFolderDelta(
  db: Db,
  client: ImapFlow,
  folder: FolderRow,
): Promise<FolderDeltaResult> {
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  let mailbox: typeof client.mailbox;
  try {
    mailbox = client.mailbox;
  } finally {
    // Released immediately: everything below either re-locks itself
    // (`ingestFolder` on a rebuild) or talks to a mailbox that is already
    // selected, which `getMailboxLock`'s fast path grants without a round
    // trip. Holding this lock across those calls would deadlock the second
    // acquisition against itself.
    lock.release();
  }
  if (!mailbox) {
    throw new Error(`Could not open folder ${folder.path}`);
  }

  const uidValidity = Number(mailbox.uidValidity);
  const rebuilt = await applyUidValidity(db, folder, uidValidity);
  if (rebuilt) {
    // Every stored UID for this folder is gone (RFC 3501 §2.3.1.1) — this is
    // no longer a delta, it is a fresh backfill. `ingestFolder` already knows
    // how to do that newest-first; re-deriving it here would drift from #34.
    const result = await ingestFolder(db, client, folder);
    return { folderId: folder.id, created: result.created, updated: 0, vanished: 0, rebuilt: true };
  }

  const total = mailbox.exists;
  const live = total > 0 ? await client.fetchAll("1:*", { uid: true, flags: true }) : [];
  const liveByUid = new Map(live.map((message) => [message.uid, [...(message.flags ?? [])]]));

  const stored = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      uid: messages.uid,
      flags: messages.flags,
    })
    .from(messages)
    .where(eq(messages.folderId, folder.id));

  const affectedThreadIds = new Set<string>();
  let created = 0;
  let updated = 0;
  let vanished = 0;

  const vanishedIds: string[] = [];
  for (const row of stored) {
    if (liveByUid.has(row.uid)) continue;
    vanishedIds.push(row.id);
    affectedThreadIds.add(row.threadId);
    vanished += 1;
  }
  if (vanishedIds.length > 0) {
    await db.delete(messages).where(inArray(messages.id, vanishedIds));
  }

  const storedByUid = new Map(stored.map((row) => [row.uid, row]));
  for (const [uid, liveFlags] of liveByUid) {
    const row = storedByUid.get(uid);
    if (!row) continue;
    if (!flagsDiffer(row.flags, new Set(liveFlags))) continue;
    await db
      .update(messages)
      .set({
        seen: liveFlags.includes("\\Seen"),
        flagged: liveFlags.includes("\\Flagged"),
        answered: liveFlags.includes("\\Answered"),
        draft: liveFlags.includes("\\Draft"),
        flags: liveFlags,
        updatedAt: new Date(),
      })
      .where(eq(messages.id, row.id));
    affectedThreadIds.add(row.threadId);
    updated += 1;
  }

  // Newest first (ADR-0005's ingest order), for consistency with #34 even
  // though a live delta is normally at most a handful of messages.
  //
  // Scoped to `uid >= previousUidNext` (RFC 3501 §2.3.1.1's uidNext
  // contract), the same boundary `qresync-catchup.ts` uses — not simply
  // "present live but not stored". A UID below that which isn't stored yet
  // is still-pending historical backfill (#36's bounded, resumable walker,
  // `sync/backfill.ts`), not a delta: treating it as "new" here would fetch
  // the whole remaining backlog unbounded in one shot the next time this
  // runs, undoing backfill's own batching.
  const previousUidNext = folder.uidNext ?? 1;
  const newUids = [...liveByUid.keys()]
    .filter((uid) => uid >= previousUidNext && !storedByUid.has(uid))
    .sort((left, right) => right - left);
  if (newUids.length > 0) {
    const fetched = await client.fetchAll(
      newUids,
      {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true,
        bodyStructure: true,
        headers: ["references"],
      },
      { uid: true },
    );
    const byUid = new Map<number, FetchMessageObject>(
      fetched.map((message) => [message.uid, message]),
    );
    for (const uid of newUids) {
      const message = byUid.get(uid);
      if (!message) continue; // vanished between the UID listing and this fetch
      const newlyStored = await storeMessage(db, folder, uidValidity, message);
      affectedThreadIds.add(newlyStored.threadId);
      created += 1;
    }
  }

  await refreshThreadRollups(db, [...affectedThreadIds]);
  if (vanishedIds.length > 0) {
    await deleteEmptyThreads(db, folder.mailAccountId);
  }

  await db
    .update(folders)
    .set({
      uidNext: mailbox.uidNext,
      highestModseq: mailbox.highestModseq ?? null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(folders.id, folder.id));

  return { folderId: folder.id, created, updated, vanished, rebuilt: false };
}

/** Re-reads a folder row by id — callers that hold a stale copy across an `await` refresh through this. */
export async function getFolderById(db: Db, folderId: string): Promise<FolderRow | null> {
  const [row] = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
  return row ?? null;
}
