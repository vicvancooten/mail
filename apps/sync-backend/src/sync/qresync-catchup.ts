import { and, eq, inArray } from "drizzle-orm";
import type { ExpungeEvent, FlagsEvent, ImapFlow, MailboxObject } from "imapflow";
import type { Db } from "../db/client.js";
import { folders, messages } from "../db/schema.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import { handleNewArrivals } from "./arrivals.js";
import { type FolderDeltaResult, flagsDiffer } from "./delta.js";
import type { FolderRow } from "./folders.js";
import { INGEST_HEADERS, storeMessage } from "./ingest.js";
import { refreshThreadRollups } from "./thread-rollup.js";
import { deleteEmptyThreads } from "./threading.js";

/**
 * The enhanced half of #35's "QRESYNC/CONDSTORE delta application with a
 * UID-diff fallback": on a QRESYNC-capable connection, re-selecting a
 * mailbox with its last known UIDVALIDITY and HIGHESTMODSEQ makes the server
 * answer with exactly what changed since — VANISHED UIDs and updated FETCH
 * flags — instead of the full UID+flags listing `delta.ts` has to fetch and
 * diff by hand. RFC 7162 §3.2.5.
 *
 * GreenMail (docs/dev-setup.md, verified for this ticket) advertises neither
 * CONDSTORE nor QRESYNC, so this path is unverified against GreenMail by
 * construction — `qresync-catchup.greenmail.test.ts` proves it degrades to
 * `null` (the fallback) there, and `qresync-catchup.live-server.test.ts`
 * exercises the real SELECT-with-QRESYNC exchange against a live server,
 * skipped unless `IMAP_QRESYNC_TEST_HOST` is set.
 *
 * Returns `null` when QRESYNC cannot be used for this folder right now — no
 * server support, no prior baseline to resync from, or the server rejected
 * the resync (a stale/mismatched UIDVALIDITY, most often) — so the caller
 * falls through to `applyFolderDelta`.
 */
export async function attemptQresyncCatchup(
  db: Db,
  client: ImapFlow,
  folder: FolderRow,
): Promise<FolderDeltaResult | null> {
  if (!client.enabled.has("QRESYNC")) return null;
  if (folder.uidValidity === null || folder.highestModseq === null) return null;

  // Only a fresh SELECT/EXAMINE actually asks the server for QRESYNC data:
  // `getMailboxLock`'s fast path skips re-selecting a mailbox that is already
  // open, silently dropping `changedSince`/`uidValidity`. Calling this before
  // anything else has touched `folder.path` on this connection (the resident
  // loop's contract) is what keeps this path meaningful.
  const collectedFlags: FlagsEvent[] = [];
  const collectedVanished: ExpungeEvent[] = [];
  const onFlags = (event: FlagsEvent) => {
    if (event.path === folder.path) collectedFlags.push(event);
  };
  const onExpunge = (event: ExpungeEvent) => {
    if (event.path === folder.path && event.vanished) collectedVanished.push(event);
  };
  client.on("flags", onFlags);
  client.on("expunge", onExpunge);

  let mailbox: MailboxObject | false;
  try {
    const lock = await client.getMailboxLock(folder.path, {
      readOnly: true,
      // ImapFlow's own JSDoc types these as a modseq string and a BigInt
      // (select.js) — the public `.d.ts` only documents `readOnly`/
      // `description`, so this pair rides through as an intentional escape
      // hatch rather than a typed option.
      ...({
        changedSince: folder.highestModseq.toString(),
        uidValidity: BigInt(folder.uidValidity),
      } as Record<string, unknown>),
    });
    mailbox = client.mailbox;
    lock.release();
  } finally {
    client.off("flags", onFlags);
    client.off("expunge", onExpunge);
  }

  if (!mailbox || !isQresyncResync(mailbox)) {
    // Not a rejection: either the server had nothing to resync from (first
    // run) or UIDVALIDITY had moved on — `applyFolderDelta`'s own
    // `applyUidValidity` check catches that and rebuilds. Either way, a full
    // UID-diff is the correct next step, not an error.
    return null;
  }

  const uidValidity = Number(mailbox.uidValidity);

  // QRESYNC's own VANISHED/FETCH pair covers everything the server already
  // knew about at the last session's HIGHESTMODSEQ, but says nothing about a
  // message that arrived after — the whole point of `changedSince` is
  // bounding the resync to *changes*, and a new message is not a change to
  // an existing one. Anything at or past the UID we last knew about is new
  // (RFC 3501 §2.3.1.1's uidNext contract), and this is deliberately a UID
  // range rather than trusting `mailbox.exists`'s delta: the count also
  // moves on an expunge, which VANISHED already accounted for above.
  const previousUidNext = folder.uidNext ?? 1;
  // Read once, ahead of the FETCH: #103's Alias resolution needs it per
  // message (`storeMessage`), and the existing Gatekeeper + Notifier hook
  // below needs it too — one lookup serves both.
  const account =
    mailbox.uidNext > previousUidNext ? await getMailAccountById(db, folder.mailAccountId) : null;
  const newUidFetch =
    mailbox.uidNext > previousUidNext
      ? await client.fetchAll(
          `${previousUidNext}:*`,
          {
            uid: true,
            flags: true,
            envelope: true,
            internalDate: true,
            size: true,
            bodyStructure: true,
            headers: [...INGEST_HEADERS],
          },
          { uid: true },
        )
      : [];

  const vanishedIds = [...new Set(collectedVanished.map((event) => event.uid).filter(isUid))];
  const affectedThreadIds = new Set<string>();
  let vanished = 0;
  if (vanishedIds.length > 0) {
    const rows = await db
      .select({ id: messages.id, threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.folderId, folder.id), inArray(messages.uid, vanishedIds)));
    for (const row of rows) affectedThreadIds.add(row.threadId);
    if (rows.length > 0) {
      await db.delete(messages).where(
        inArray(
          messages.id,
          rows.map((row) => row.id),
        ),
      );
      vanished = rows.length;
    }
  }

  let updated = 0;
  for (const event of collectedFlags) {
    if (!isUid(event.uid)) continue;
    const [row] = await db
      .select({ id: messages.id, threadId: messages.threadId, flags: messages.flags })
      .from(messages)
      .where(and(eq(messages.folderId, folder.id), eq(messages.uid, event.uid)));
    if (!row) continue; // a flag change on a message this account has not stored yet
    const liveFlags = [...event.flags];
    if (!flagsDiffer(row.flags, event.flags)) continue;
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

  let created = 0;
  const createdMessageIds: string[] = [];
  // Oldest-UID-first is fine here (unlike #34's backfill order): this is at
  // most the handful of messages that arrived while disconnected, not a
  // newest-first backfill concern.
  for (const message of newUidFetch) {
    const stored = await storeMessage(
      db,
      folder,
      uidValidity,
      message,
      account?.emailAddress ?? "",
    );
    affectedThreadIds.add(stored.threadId);
    createdMessageIds.push(stored.id);
    created += 1;
  }
  // The Gatekeeper + Notifier hook (#55, #53, ADR-0015) — same reasoning as
  // `delta.ts`'s own new-UID loop: this whole function only ever runs for a
  // live reconnect/poll catch-up, never backfill.
  if (createdMessageIds.length > 0 && account) {
    await handleNewArrivals(db, folder, account, createdMessageIds);
  }

  await refreshThreadRollups(db, [...affectedThreadIds]);
  if (vanished > 0) {
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

function isUid(value: number | undefined): value is number {
  return typeof value === "number";
}

/** `map.qresync` (select.js) is not part of the public `MailboxObject` type — this is the escape hatch back. */
function isQresyncResync(mailbox: MailboxObject): boolean {
  return (mailbox as MailboxObject & { qresync?: boolean }).qresync === true;
}
