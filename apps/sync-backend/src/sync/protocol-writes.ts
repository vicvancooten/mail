import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import type { Db, Tx } from "../db/client.js";
import { folders, messages, protocolWrites } from "../db/schema.js";
import { isGmailAccount, type MailAccountServerKind } from "../mail-accounts/server-kind.js";
import { getMailAccountServerKind } from "../mail-accounts/store.js";
import { type FolderRole, findFolderByRole } from "./folders.js";
import { projectGmailThreadStatus } from "./inbox.js";

/**
 * The write-through outbox's other half (#42, ADR-0006): `sync/mutations.ts`
 * enqueues, this drains. See `protocolWrites`'s doc comment (`db/schema.ts`)
 * for why the table is keyed to `messageId` rather than `threadId` and why a
 * row carries no target value of its own — everything this file needs is a
 * *fresh* read of the Message's current folder, labels and flags, never a
 * value captured at enqueue time.
 *
 * `archive`/`inbox` gain a second shape on Gmail (#124, ADR-0020): the
 * server-kind gate below (`isGmailAccount(serverKind)`) decides, for every row
 * of either kind, whether it becomes a real `MOVE` (every other server) or
 * an `X-GM-LABELS` add/remove of `\Inbox` on the All Mail UID — imapflow
 * returns `false` silently for a label `STORE` against a non-Gmail server,
 * so this gate has to sit above the call, never inside it. `trash`/`junk`
 * are never label operations, on any server: Gmail drops a moved message
 * out of All Mail on its own, which is the whole point of keeping Trash and
 * Spam real moves (ADR-0020's Consequences).
 */
export type ProtocolWriteKind = "seen" | "flagged" | "archive" | "trash" | "inbox" | "junk";

/**
 * `sync/mutations.ts`'s only way to add to the outbox. A no-op on an empty
 * list. Takes `Db | Tx` rather than `Db` alone so `sync/restore-to-inbox.ts`
 * can enqueue the "inbox" reversal inside the same transaction that cancels
 * a still-queued original — one insert statement either way, so there is
 * nothing transaction-specific here to get wrong.
 */
export async function enqueueProtocolWrites(
  db: Db | Tx,
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
  folderRole: FolderRole | null;
  gmailLabels: string[] | null;
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

  // One lookup for the whole batch, not per row — the same "resolve the
  // account once" shape `thread-rollup.ts` uses for its own Gmail branch.
  const serverKind = await getMailAccountServerKind(db, mailAccountId);

  const messageIds = [...new Set(rows.map((row) => row.messageId))];
  const current = await db
    .select({
      id: messages.id,
      uid: messages.uid,
      seen: messages.seen,
      flagged: messages.flagged,
      folderPath: folders.path,
      folderRole: folders.role,
      gmailLabels: messages.gmailLabels,
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
    if (isAlreadyApplied(serverKind, row.kind, msg)) {
      // Already there: a prior drain applied it, or another IMAP client
      // (or the User, from another device) moved/labelled it there first.
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
      await drainFolder(db, client, mailAccountId, serverKind, folderRows, byMessageId, done);
    } finally {
      lock.release();
    }
  }

  if (done.size > 0) await db.delete(protocolWrites).where(inArray(protocolWrites.id, [...done]));
  return done.size;
}

/**
 * Whether a `archive`/`trash`/`inbox`/`junk` row's effect is already true of
 * the Message, so the drain skips it rather than re-issuing a redundant
 * `STORE`/`MOVE`. `trash`/`junk` are always real Folders, on every server,
 * so `folderRole` alone answers it. `archive`/`inbox` mean "not in the
 * Inbox"/"in the Inbox" on Gmail — read through `projectGmailThreadStatus`
 * rather than `sync/inbox.ts#isInInbox` directly, because a message actually
 * sitting in Trash/Junk can still carry a stale `\Inbox` label (that
 * function's own doc comment) and must not read as "already restored" until
 * the real move back out of Trash/Junk has happened.
 */
function isAlreadyApplied(
  serverKind: MailAccountServerKind,
  kind: ProtocolWriteKind,
  msg: CurrentMessage,
): boolean {
  if (kind === "trash" || kind === "junk") return msg.folderRole === kind;
  if (kind === "archive" || kind === "inbox") {
    if (isGmailAccount(serverKind)) {
      const inInbox = projectGmailThreadStatus(msg.folderRole, msg.gmailLabels).inInbox;
      return kind === "archive" ? !inInbox : inInbox;
    }
    return msg.folderRole === kind;
  }
  return false;
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
  serverKind: MailAccountServerKind,
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
  const inboxRows: OutboxRow[] = [];
  const junkRows: OutboxRow[] = [];

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
      case "inbox":
        inboxRows.push(row);
        break;
      case "junk":
        junkRows.push(row);
        break;
    }
  }

  await flagBatch(client, byMessageId, seenOn, "\\Seen", true, done);
  await flagBatch(client, byMessageId, seenOff, "\\Seen", false, done);
  await flagBatch(client, byMessageId, flaggedOn, "\\Flagged", true, done);
  await flagBatch(client, byMessageId, flaggedOff, "\\Flagged", false, done);

  // The server-kind gate (#124, ADR-0020): on Gmail, Done and its Undo never
  // move anything — they are `\Inbox` label removes/adds on the All Mail UID
  // the row already sits in. Everywhere else they are the ordinary `MOVE`.
  // `inbox` additionally has to split on Gmail: a Thread's Undo can be
  // restoring a Done (still in All Mail, wants the label back) or reversing
  // a real Deny/Block/Spam move out of Trash/Junk (`restore-to-inbox.ts`),
  // which needs the real `MOVE` back into All Mail those two Folders are the
  // one place a Gmail `inbox` write still is one.
  if (isGmailAccount(serverKind)) {
    const { toLabel, toMove } = partitionGmailInboxRows(inboxRows, byMessageId);
    await labelBatch(db, client, byMessageId, archiveRows, "\\Inbox", false, done);
    await labelBatch(db, client, byMessageId, toLabel, "\\Inbox", true, done);
    await moveBatch(db, client, mailAccountId, "all", toMove, byMessageId, done);
  } else {
    await moveBatch(db, client, mailAccountId, "archive", archiveRows, byMessageId, done);
    // Undo's own real inverse (#95, ADR-0019): moves a Message back to the
    // Inbox the same way `archive`/`trash` move it out.
    await moveBatch(db, client, mailAccountId, "inbox", inboxRows, byMessageId, done);
  }
  await moveBatch(db, client, mailAccountId, "trash", trashRows, byMessageId, done);
  await moveBatch(db, client, mailAccountId, "junk", junkRows, byMessageId, done);
}

/** Splits a Gmail account's `inbox` rows between a label-add (still in All Mail) and a real move back (still in Trash/Junk) — see `drainFolder`'s own comment. */
function partitionGmailInboxRows(
  rows: OutboxRow[],
  byMessageId: Map<string, CurrentMessage>,
): { toLabel: OutboxRow[]; toMove: OutboxRow[] } {
  const toLabel: OutboxRow[] = [];
  const toMove: OutboxRow[] = [];
  for (const row of rows) {
    const msg = byMessageId.get(row.messageId);
    if (msg && (msg.folderRole === "trash" || msg.folderRole === "junk")) {
      toMove.push(row);
    } else {
      toLabel.push(row);
    }
  }
  return { toLabel, toMove };
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

/**
 * Gmail's `\Inbox` label add/remove (#124, ADR-0020) — the same `STORE`
 * `flagBatch` above issues, plus `useLabels: true` so imapflow updates
 * `X-GM-LABELS` instead of ordinary IMAP flags. Only ever called once the
 * server-kind gate has already confirmed this is a Gmail account
 * (`drainFolder`) — imapflow answers a label `STORE` against a non-Gmail
 * server with a silent `false`, not an error, so that gate has to sit above
 * this call rather than be re-checked inside it.
 *
 * Updates `messages.gmailLabels` on success, the same "write back what the
 * server confirmed" shape `moveBatch` gives `folderId`/`uid` — otherwise the
 * next drain's `isAlreadyApplied` check would see a stale label set and
 * queue this account's own recent work right back onto the outbox.
 */
async function labelBatch(
  db: Db,
  client: ImapFlow,
  byMessageId: Map<string, CurrentMessage>,
  rows: OutboxRow[],
  label: string,
  add: boolean,
  done: Set<string>,
): Promise<void> {
  if (rows.length === 0) return;
  const uids = rows
    .map((row) => byMessageId.get(row.messageId)?.uid)
    .filter((uid): uid is number => uid !== undefined);
  if (uids.length === 0) return;
  const ok = add
    ? await client.messageFlagsAdd(uids, [label], { uid: true, useLabels: true })
    : await client.messageFlagsRemove(uids, [label], { uid: true, useLabels: true });
  if (!ok) return; // Failed — leave queued for the next drain pass.

  for (const row of rows) {
    const msg = byMessageId.get(row.messageId);
    if (!msg) continue;
    const current = msg.gmailLabels ?? [];
    const updated = add
      ? current.includes(label)
        ? current
        : [...current, label]
      : current.filter((existing) => existing !== label);
    await db.update(messages).set({ gmailLabels: updated }).where(eq(messages.id, msg.id));
    done.add(row.id);
  }
}

async function moveBatch(
  db: Db,
  client: ImapFlow,
  mailAccountId: string,
  role: "archive" | "trash" | "inbox" | "junk" | "all",
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
