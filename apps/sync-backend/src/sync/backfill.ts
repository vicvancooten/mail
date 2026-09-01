import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { folders } from "../db/schema.js";
import { type FolderRow, listSelectableFolders } from "./folders.js";
import { applyUidValidity, fetchAndStoreSequenceBatch } from "./ingest.js";

/**
 * Full-history header backfill (#36): the resident sync loop's background
 * walk of every selectable folder's history, newest-first, bounded and
 * resumable — the part `sync/ingest.ts`'s unbounded `ingestFolder` never had
 * to be, because until now it always ran to completion synchronously before
 * anything else could happen.
 *
 * The split mirrors #35's own: `establishFolderBaseline` is the fast,
 * message-free step every folder goes through once at connect (or on a
 * UIDVALIDITY rebuild) so the resident loop's IDLE/delta machinery has a
 * baseline to work from immediately; `runBackfillBatch`/`runAccountBackfill`
 * are the slow part, walking sequence numbers downward a bounded batch at a
 * time so the one shared IMAP connection (ADR-0005) keeps yielding to
 * whatever IDLE or a poll tick needs it for.
 */

/** One FETCH per batch — matches `ingest.ts`'s own default. */
const DEFAULT_BATCH_SIZE = 200;
/** Yielded between batches so a live wake or poll tick queued behind this one isn't starved. */
const DEFAULT_PAUSE_MS = 50;

export interface EstablishBaselineResult {
  /** True when UIDVALIDITY had changed and the folder's messages were wiped and re-baselined. */
  rebuilt: boolean;
  /**
   * True when this call is what just gave the folder its first-ever baseline
   * (a fresh folder, or one just rebuilt): `uidNext`/`highestModseq` are
   * brand new and every one of its messages is now backfill's job, not a
   * delta's. False for a folder that was already tracked coming in — this
   * call was a no-op, and whatever's missing since last time is a genuine
   * delta (`sync/delta.ts` / `sync/qresync-catchup.ts`), not backfill.
   */
  established: boolean;
}

/**
 * Establishes (or re-establishes, on a UIDVALIDITY change) a folder's sync
 * baseline: UIDVALIDITY/uidNext/highestModseq and a fresh backfill cursor
 * pointing at the folder's current `exists` count. Reads mailbox metadata
 * only — no FETCH, no message touched — so it is safe to call on every
 * connect regardless of how much backfill has (or hasn't) completed; it is a
 * complete no-op for a folder that's already tracked and wasn't rebuilt.
 */
export async function establishFolderBaseline(
  db: Db,
  client: ImapFlow,
  folder: FolderRow,
): Promise<EstablishBaselineResult> {
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  let mailbox: typeof client.mailbox;
  try {
    mailbox = client.mailbox;
  } finally {
    lock.release();
  }
  if (!mailbox) {
    throw new Error(`Could not open folder ${folder.path}`);
  }

  const uidValidity = Number(mailbox.uidValidity);
  const rebuilt = await applyUidValidity(db, folder, uidValidity);
  const alreadyTracked = folder.uidValidity !== null && !rebuilt;
  if (alreadyTracked) {
    return { rebuilt: false, established: false };
  }

  await db
    .update(folders)
    .set({
      uidValidity,
      uidNext: mailbox.uidNext,
      highestModseq: mailbox.highestModseq ?? null,
      lastSyncedAt: new Date(),
      backfillCursorSeq: mailbox.exists,
      backfillComplete: mailbox.exists === 0,
      updatedAt: new Date(),
    })
    .where(eq(folders.id, folder.id));

  return { rebuilt, established: true };
}

export interface BackfillBatchResult {
  folderId: string;
  ingested: number;
  /** True once this folder's backfill cursor has reached sequence 1. */
  done: boolean;
}

/**
 * One bounded batch of a folder's historical header backfill, resuming from
 * its persisted cursor — safe to call again after a crash or restart with
 * no argument telling it where it left off, because that's exactly what
 * `folder.backfillCursorSeq` is for.
 */
export async function runBackfillBatch(
  db: Db,
  client: ImapFlow,
  folder: FolderRow,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<BackfillBatchResult> {
  if (
    folder.backfillComplete ||
    folder.backfillCursorSeq === null ||
    folder.backfillCursorSeq <= 0
  ) {
    // Nothing left, or backfill was never established for this folder (a
    // caller error — `establishFolderBaseline` runs before this on every
    // connect) — either way there is no batch to run.
    if (!folder.backfillComplete) {
      await db
        .update(folders)
        .set({ backfillComplete: true, backfillCursorSeq: 0, updatedAt: new Date() })
        .where(eq(folders.id, folder.id));
    }
    return { folderId: folder.id, ingested: 0, done: true };
  }

  // Held for the whole batch, not just the metadata read — `ingestFolder`'s
  // own contract, and load-bearing here for a different reason: releasing
  // early and then issuing `fetchAll` unguarded leaves a window where a
  // concurrent lock request on *this* connection (the body sweep, or the
  // next `establishFolderBaseline`) can select a different mailbox before
  // this batch's FETCH goes out, sending it against the wrong folder.
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    if (!mailbox) {
      throw new Error(`Could not open folder ${folder.path}`);
    }

    const uidValidity = Number(mailbox.uidValidity);
    // Defensive re-check: a UIDVALIDITY change between batches (rare — the
    // resident loop's own delta/poll passes are the usual place this is
    // caught) means every stored message is gone and the cursor has to
    // restart from this connection's fresh `exists`, exactly like a first
    // connect.
    const rebuilt = await applyUidValidity(db, folder, uidValidity);
    if (rebuilt) {
      await db
        .update(folders)
        .set({
          uidValidity,
          uidNext: mailbox.uidNext,
          highestModseq: mailbox.highestModseq ?? null,
          lastSyncedAt: new Date(),
          backfillCursorSeq: mailbox.exists,
          backfillComplete: mailbox.exists === 0,
          updatedAt: new Date(),
        })
        .where(eq(folders.id, folder.id));
      return { folderId: folder.id, ingested: 0, done: mailbox.exists === 0 };
    }

    // Clamped against the mailbox's current `exists`: sequence numbers
    // renumber on an EXPUNGE (unlike UIDs), so a message deleted by another
    // IMAP client between batches can leave the persisted cursor pointing
    // past the end of a now-shorter mailbox. Known limitation this doesn't
    // fully close: an expunge that renumbers messages still *below* the
    // clamped cursor can shift a handful of not-yet-backfilled messages out
    // from under it unnoticed, since they're below `uidNext` and therefore
    // not `sync/delta.ts`'s job either — rare enough, and low-stakes enough
    // (a missing message, not a corrupted one), not to justify a UID-addressed
    // redesign of this walk for the PoC.
    const high = Math.min(folder.backfillCursorSeq, mailbox.exists);
    const low = Math.max(1, high - batchSize + 1);
    const batch = await fetchAndStoreSequenceBatch(db, client, folder, uidValidity, { low, high });

    const done = low <= 1;
    await db
      .update(folders)
      .set({
        backfillCursorSeq: done ? 0 : low - 1,
        backfillComplete: done,
        updatedAt: new Date(),
      })
      .where(eq(folders.id, folder.id));

    return { folderId: folder.id, ingested: batch.length, done };
  } finally {
    lock.release();
  }
}

/** A tiny sleep that also resolves early on `stopSignal` — same shape as `live-session.ts`'s own. */
function sleep(ms: number, stopSignal: Promise<void>): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
    stopSignal,
  ]);
}

export interface AccountBackfillOptions {
  batchSize?: number;
  /** Paused between batches so IDLE/poll traffic queued behind one never waits long. */
  pauseMs?: number;
  stopSignal: Promise<void>;
  isStopped: () => boolean;
}

/**
 * Walks every selectable folder's backfill to completion, one bounded batch
 * at a time, folder-priority order (Inbox first — `folders.ts`'s
 * `ROLE_PRIORITY`) — the account-wide loop `sync/live-session.ts` runs
 * alongside IDLE and polling. Re-reads folder state from the database on
 * every iteration rather than holding it in memory, so a restart mid-account
 * resumes each folder exactly where its own cursor left off, and a folder
 * created after this call started (a poll discovering a new mailbox) is
 * picked up without a separate signal.
 */
export async function runAccountBackfill(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
  options: AccountBackfillOptions,
): Promise<void> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;

  while (!options.isStopped()) {
    const live = await listSelectableFolders(db, mailAccountId);
    const target = live.find((folder) => !folder.backfillComplete);
    if (!target) return; // every folder's history is in — this account's backfill is done

    await runBackfillBatch(db, client, target, batchSize);
    if (options.isStopped()) return;
    await sleep(pauseMs, options.stopSignal);
  }
}
