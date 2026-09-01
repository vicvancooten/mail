import { createHash } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import { buildDraftMime } from "../compose/draft-mime.js";
import type { Db } from "../db/client.js";
import { type CompositionRow, compositions } from "../db/schema.js";
import { findFolderByRole } from "./folders.js";

/**
 * The debounced IMAP Drafts push (ADR-0012 tier 2, #45): exports a
 * `draft`-status Composition as a MIME message into the account's Drafts
 * folder so a draft started in Mail is readable and finishable in any other
 * IMAP client. This file is the per-account push itself;
 * `sync/draft-push-loop.ts` is what calls it on an interval, mirroring
 * `sync/protocol-writes.ts` / `protocol-write-loop.ts`'s own split.
 *
 * A push is a no-op — never a user-visible error (ADR-0012: "a failed push
 * is never a user-visible error") — for a Composition still mid-edit (its
 * `updatedAt` inside the idle window below), one whose content hash already
 * matches what was last pushed, or an account with no discoverable Drafts
 * folder.
 */

/** ADR-0012: "~30s of composition idle" — an autosave younger than this is still being typed. */
export const DRAFT_PUSH_IDLE_MS = 30_000;

/** Drafts still being edited (too fresh) or already exported at their current content never reach the network. */
export async function pendingDraftPushes(
  db: Db,
  mailAccountId: string,
  now: Date = new Date(),
): Promise<CompositionRow[]> {
  const cutoff = new Date(now.getTime() - DRAFT_PUSH_IDLE_MS);
  const rows = await db
    .select()
    .from(compositions)
    .where(
      and(
        eq(compositions.mailAccountId, mailAccountId),
        eq(compositions.status, "draft"),
        lte(compositions.updatedAt, cutoff),
      ),
    );
  return rows.filter((row) => computeContentHash(row) !== row.pushedContentHash);
}

/** sha256 over exactly the fields that end up in the exported MIME — anything else changing must not trigger a re-push. */
export function computeContentHash(row: CompositionRow): string {
  const material = JSON.stringify({
    subject: row.subject,
    document: row.document,
    to: row.toAddresses,
    cc: row.ccAddresses,
    bcc: row.bccAddresses,
  });
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Pushes every idle, changed Draft for one Mail Account over an
 * already-connected client. Folder discovery degrades rather than creates
 * (ADR-0012): no Drafts folder on this account skips every candidate
 * silently, logged once by the caller rather than per-Composition.
 */
export async function pushDraftsForAccount(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
  fromAddress: string,
): Promise<{ pushed: number; skippedNoFolder: boolean }> {
  const candidates = await pendingDraftPushes(db, mailAccountId);
  if (candidates.length === 0) return { pushed: 0, skippedNoFolder: false };

  const draftsFolder = await findFolderByRole(db, mailAccountId, "drafts");
  if (!draftsFolder) return { pushed: 0, skippedNoFolder: true };

  let pushed = 0;
  const lock = await client.getMailboxLock(draftsFolder.path);
  try {
    for (const row of candidates) {
      await pushOne(db, client, draftsFolder.path, draftsFolder.id, row, fromAddress);
      pushed += 1;
    }
  } finally {
    lock.release();
  }
  return { pushed, skippedNoFolder: false };
}

/**
 * One Composition's push. **Foreign edits are never destroyed** (ADR-0012):
 * the previously-pushed UID is only expunged after confirming it still
 * resolves to a real message. If it no longer does — deleted, or replaced by
 * a foreign client's own supersede, which over IMAP looks identical — this
 * is `pushDraftsForAccount`'s "deletion is asymmetric" path: nothing is
 * expunged (there is nothing left to), the stale UID is simply dropped and
 * a fresh copy appended, rather than either resurrecting what a foreign
 * client removed or silently overwriting a foreign client's own edit under
 * a UID we no longer recognize.
 */
async function pushOne(
  db: Db,
  client: ImapFlow,
  folderPath: string,
  folderId: string,
  row: CompositionRow,
  fromAddress: string,
): Promise<void> {
  const hash = computeContentHash(row);
  const mime = await buildDraftMime(db, row, fromAddress);

  const previousUid =
    row.imapDraftUid !== null && (await uidStillExists(client, row.imapDraftUid))
      ? row.imapDraftUid
      : null;

  const appended = await client.append(folderPath, mime, ["\\Draft", "\\Seen"]);
  const newUid = appended && typeof appended.uid === "number" ? appended.uid : null;

  if (previousUid !== null) {
    await client.messageDelete(previousUid, { uid: true }).catch(() => undefined);
  }

  await db
    .update(compositions)
    .set({
      imapDraftUid: newUid,
      imapDraftFolderId: folderId,
      pushedContentHash: hash,
      lastPushedAt: new Date(),
    })
    .where(eq(compositions.id, row.id));
}

async function uidStillExists(client: ImapFlow, uid: number): Promise<boolean> {
  const result = await client.fetchOne(String(uid), { uid: true }, { uid: true });
  return result !== false;
}
