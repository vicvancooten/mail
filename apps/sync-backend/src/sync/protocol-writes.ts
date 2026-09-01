import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { folders, messages, protocolWrites } from "../db/schema.js";
import { findFolderByRole } from "./folders.js";

/**
 * The write-through outbox's other half (#42, ADR-0006): `sync/mutations.ts`
 * enqueues, this drains. See `protocolWrites`'s doc comment (`db/schema.ts`)
 * for why the table is keyed to `messageId` rather than `threadId` and why a
 * row carries no target value of its own — everything this file needs is a
 * *fresh* read of the Message's current folder and flags, never a value
 * captured at enqueue time.
 */

export type ProtocolWriteKind = "seen" | "flagged" | "archive" | "trash";

/** `sync/mutations.ts`'s only way to add to the outbox. A no-op on an empty list. */
export async function enqueueProtocolWrites(
  db: Db,
  mailAccountId: string,
  messageIds: string[],
  kind: ProtocolWriteKind,
): Promise<void> {
  if (messageIds.length === 0) return;
  await db
    .insert(protocolWrites)
    .values(messageIds.map((messageId) => ({ id: randomUUID(), mailAccountId, messageId, kind })));
}

interface CurrentMessage {
  id: string;
  uid: number;
  seen: boolean;
  flagged: boolean;
  folderPath: string;
  folderRole: string | null;
}

type OutboxRow = { id: string; messageId: string; kind: ProtocolWriteKind };

/**
 * Applies every queued write for one Mail Account against an already-open,
 * already-selected-nothing connection, then deletes the rows it managed to
 * apply. Rows it could not apply (a failed command, no Archive/Trash folder
 * on this account) are left queued — the next drain pass, on the next
 * interval tick (`sync/protocol-write-loop.ts`), tries them again. There is
 * no explicit rollback path: ADR-0006 reconciles a permanent failure through
 * "the existing state-token sync loop" — the ordinary IDLE/poll delta already
 * overwrites `messages.seen`/`flagged` from whatever IMAP actually reports,
 * so a write that never lands simply never gets confirmed, and the Sync
 * Backend's own state is corrected the next time it hears from the server.
 *
 * Returns how many rows were applied, for tests and logging — never awaited
 * for correctness by any caller.
 */
export async function drainProtocolWrites(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
): Promise<number> {
  const rows: OutboxRow[] = await db
    .select({
      id: protocolWrites.id,
      messageId: protocolWrites.messageId,
      kind: protocolWrites.kind,
    })
    .from(protocolWrites)
    .where(eq(protocolWrites.mailAccountId, mailAccountId))
    .orderBy(asc(protocolWrites.createdAt));
  if (rows.length === 0) return 0;

  const messageIds = [...new Set(rows.map((row) => row.messageId))];
  const current = await db
    .select({
      id: messages.id,
      uid: messages.uid,
      seen: messages.seen,
      flagged: messages.flagged,
      folderPath: folders.path,
      folderRole: folders.role,
    })
    .from(messages)
    .innerJoin(folders, eq(messages.folderId, folders.id))
    .where(inArray(messages.id, messageIds));
  const byMessageId = new Map<string, CurrentMessage>(
    current.map((row) => [row.id, { ...row, uid: Number(row.uid) }]),
  );

  const done = new Set<string>();
  const byFolderPath = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    const msg = byMessageId.get(row.messageId);
    if (!msg) {
      // The Message is gone — expunged, or its Thread merged away — since
      // this was queued. Nothing left to write through.
      done.add(row.id);
      continue;
    }
    if ((row.kind === "archive" || row.kind === "trash") && msg.folderRole === row.kind) {
      // Already there: a prior drain applied it, or another IMAP client
      // (or the User, from another device) moved it there first.
      done.add(row.id);
      continue;
    }
    const bucket = byFolderPath.get(msg.folderPath) ?? [];
    bucket.push(row);
    byFolderPath.set(msg.folderPath, bucket);
  }

  for (const [folderPath, folderRows] of byFolderPath) {
    const lock = await client.getMailboxLock(folderPath);
    try {
      await drainFolder(db, client, mailAccountId, folderRows, byMessageId, done);
    } finally {
      lock.release();
    }
  }

  if (done.size > 0) await db.delete(protocolWrites).where(inArray(protocolWrites.id, [...done]));
  return done.size;
}

/**
 * One already-locked folder's share of the batch: flag writes are grouped by
 * (flag, direction) and archive/trash moves by target folder, so a
 * multi-message Thread costs one `STORE`/`MOVE` each rather than one per
 * Message.
 */
async function drainFolder(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
  folderRows: OutboxRow[],
  byMessageId: Map<string, CurrentMessage>,
  done: Set<string>,
): Promise<void> {
  const seenOn: OutboxRow[] = [];
  const seenOff: OutboxRow[] = [];
  const flaggedOn: OutboxRow[] = [];
  const flaggedOff: OutboxRow[] = [];
  const archiveRows: OutboxRow[] = [];
  const trashRows: OutboxRow[] = [];

  for (const row of folderRows) {
    const msg = byMessageId.get(row.messageId);
    if (!msg) continue; // narrowed already by the caller; kept for type safety
    switch (row.kind) {
      case "seen":
        (msg.seen ? seenOn : seenOff).push(row);
        break;
      case "flagged":
        (msg.flagged ? flaggedOn : flaggedOff).push(row);
        break;
      case "archive":
        archiveRows.push(row);
        break;
      case "trash":
        trashRows.push(row);
        break;
    }
  }

  await flagBatch(client, byMessageId, seenOn, "\\Seen", true, done);
  await flagBatch(client, byMessageId, seenOff, "\\Seen", false, done);
  await flagBatch(client, byMessageId, flaggedOn, "\\Flagged", true, done);
  await flagBatch(client, byMessageId, flaggedOff, "\\Flagged", false, done);
  await moveBatch(db, client, mailAccountId, "archive", archiveRows, byMessageId, done);
  await moveBatch(db, client, mailAccountId, "trash", trashRows, byMessageId, done);
}

async function flagBatch(
  client: ImapFlow,
  byMessageId: Map<string, CurrentMessage>,
  rows: OutboxRow[],
  flag: string,
  add: boolean,
  done: Set<string>,
): Promise<void> {
  if (rows.length === 0) return;
  const uids = rows
    .map((row) => byMessageId.get(row.messageId)?.uid)
    .filter((uid): uid is number => uid !== undefined);
  if (uids.length === 0) return;
  const ok = add
    ? await client.messageFlagsAdd(uids, [flag], { uid: true })
    : await client.messageFlagsRemove(uids, [flag], { uid: true });
  if (ok) for (const row of rows) done.add(row.id);
}

async function moveBatch(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
  role: "archive" | "trash",
  rows: OutboxRow[],
  byMessageId: Map<string, CurrentMessage>,
  done: Set<string>,
): Promise<void> {
  if (rows.length === 0) return;
  const target = await findFolderByRole(db, mailAccountId, role);
  if (!target) return; // No such folder on this account (yet) — leave queued; nothing to reconcile without a destination.

  const uids = rows
    .map((row) => byMessageId.get(row.messageId)?.uid)
    .filter((uid): uid is number => uid !== undefined);
  if (uids.length === 0) return;
  const result = await client.messageMove(uids, target.path, { uid: true });
  if (!result) return; // Failed — leave queued for the next drain pass.

  for (const row of rows) {
    const msg = byMessageId.get(row.messageId);
    if (!msg) continue;
    const newUid = result.uidMap?.get(msg.uid);
    await db
      .update(messages)
      .set({
        folderId: target.id,
        ...(newUid !== undefined ? { uid: newUid } : {}),
        ...(result.uidValidity !== undefined ? { uidValidity: Number(result.uidValidity) } : {}),
      })
      .where(eq(messages.id, msg.id));
    done.add(row.id);
  }
}
