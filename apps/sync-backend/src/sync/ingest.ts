import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type {
  FetchMessageObject,
  FetchQueryObject,
  ImapFlow,
  MessageAddressObject,
} from "imapflow";
import type { Db } from "../db/client.js";
import { folders, type MessageAddress, messages } from "../db/schema.js";
import { resolveRecipientAlias } from "../gatekeeper/alias.js";
import type { MailAccountServerKind } from "../mail-accounts/server-kind.js";
import { bumpThreadsEpoch, getMailAccountById } from "../mail-accounts/store.js";
import { fetchMessageBody, storeMessageBody } from "./bodies.js";
import { hasRealAttachments, readBodyParts } from "./body-structure.js";
import {
  activityForMessage,
  capCorrespondents,
  recordCorrespondentActivity,
  wasRecordedAtSend,
} from "./correspondents.js";
import type { FolderRow } from "./folders.js";
import { extractReferencesHeader, normalizeMessageId, threadingIdsFor } from "./message-ids.js";
import { reindexMessages } from "./search-index.js";
import { refreshThreadRollups } from "./thread-rollup.js";
import { deleteEmptyThreads, resolveThread } from "./threading.js";

/**
 * The extra headers every ingest FETCH asks for beyond the envelope: the
 * `References` chain threading needs (`message-ids.ts`) plus the two Alias
 * headers #103's `gatekeeper/alias.ts#resolveRecipientAlias` reads —
 * `Delivered-To`/`X-Original-To` are not part of ImapFlow's `envelope`
 * (they are ordinary headers, not envelope fields), so they only ever reach
 * `storeMessage` through this list. Shared by every FETCH that stores a
 * message (`ingest.ts`, `sync/delta.ts`, `sync/qresync-catchup.ts`) so the
 * three can never drift on what a message needs to resolve its Alias.
 */
export const INGEST_HEADERS = ["references", "delivered-to", "x-original-to"] as const;

/**
 * The one FETCH shape every ingest path asks for (`ingest.ts`, `delta.ts`,
 * `qresync-catchup.ts`) — headers/envelope/bodystructure as above, plus
 * Gmail Labels (`X-GM-LABELS`) when and only when this folder is Gmail's All
 * Mail (#122, ADR-0020): that is the one Folder a Gmail message's Labels are
 * ever read from, and asking elsewhere would either come back empty (Spam,
 * Trash, Drafts never carry a second copy to label) or be meaningless (a
 * non-Gmail server doesn't have `X-GM-EXT-1` to answer it at all).
 */
export function buildIngestFetchQuery(
  folder: FolderRow,
  serverKind: MailAccountServerKind | null,
): FetchQueryObject {
  return {
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
    size: true,
    bodyStructure: true,
    headers: [...INGEST_HEADERS],
    ...(folder.role === "all" && serverKind === "gmail" ? { labels: true } : {}),
  };
}

/**
 * Header ingest for one folder (#34), newest first.
 *
 * "Newest first" is ADR-0005's backfill order and it is a product
 * requirement, not an optimization: the User is waiting on the top of their
 * Inbox, and a chronological ingest would fill it in last. IMAP sequence
 * numbers are arrival order, so walking them downwards in batches gives
 * strictly-newest-first with one FETCH per batch.
 *
 * What is fetched per message is everything that is free alongside the
 * envelope — flags, INTERNALDATE, size, BODYSTRUCTURE and the `References`
 * header — and nothing that is not. Bodies are lazy (`sync/bodies.ts`).
 *
 * This module assumes it is the only writer for a given Mail Account at a
 * time; ADR-0005's "one IMAP connection per Mail Account" makes that true
 * for the sync loop, and `resolveThread`'s read-then-write is the part that
 * depends on it.
 *
 * What this pass deliberately does **not** do is notice messages that have
 * gone away. An ingest only ever adds and refreshes; reconciling expunges
 * needs the QRESYNC `VANISHED` set or a full UID diff, which is #35's
 * delta loop. Until that lands, a message deleted by another IMAP client
 * stays in the store.
 */

/** One FETCH per batch. Big enough to amortize the round trip, small enough that a resume loses little. */
const DEFAULT_BATCH_SIZE = 200;

export interface IngestedMessage {
  id: string;
  threadId: string;
  uid: number;
  receivedAt: Date;
  /** False when the row already existed and was refreshed rather than created. */
  created: boolean;
}

export interface IngestFolderOptions {
  batchSize?: number;
  /** Stops after this many messages — the newest N. Unbounded when omitted (#36 owns full backfill). */
  limit?: number;
  /**
   * Fetch and store each message's body during this pass. Off by default:
   * ADR-0005 wants headers first and bodies behind #36's sweep. The e2e
   * tests and small mailboxes turn it on.
   */
  fetchBodies?: boolean;
  /** Called once per batch, newest batch first, with the messages in stored order. */
  onBatch?: (batch: IngestedMessage[]) => void | Promise<void>;
}

export interface IngestFolderResult {
  folderId: string;
  ingested: number;
  created: number;
  /** True when UIDVALIDITY changed and the folder's messages were rebuilt (ADR-0011's `reset`). */
  rebuilt: boolean;
}

export async function ingestFolder(
  db: Db,
  client: ImapFlow,
  folder: FolderRow,
  options: IngestFolderOptions = {},
): Promise<IngestFolderResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  // EXAMINE, not SELECT: ingest must never be the thing that marks a User's
  // mail read. Read state only ever moves the other way here — off `\Seen`
  // and into the store (ADR-0006).
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  const result: IngestFolderResult = {
    folderId: folder.id,
    ingested: 0,
    created: 0,
    rebuilt: false,
  };

  try {
    const mailbox = client.mailbox;
    if (!mailbox) {
      throw new Error(`Could not open folder ${folder.path}`);
    }

    const uidValidity = Number(mailbox.uidValidity);
    result.rebuilt = await applyUidValidity(db, folder, uidValidity);

    await db
      .update(folders)
      .set({
        uidValidity,
        uidNext: mailbox.uidNext,
        highestModseq: mailbox.highestModseq ?? null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(folders.id, folder.id));

    const total = mailbox.exists;
    let high = total;

    if (total > 0) {
      const wanted = options.limit ?? total;
      // Fetched once per folder pass, not per batch or per message — an
      // account's own address never changes mid-sync, and this is the one
      // thing `fetchAndStoreSequenceBatch`'s per-message Alias resolution
      // (#103) needs that a FETCH itself can't supply.
      const account = await getMailAccountById(db, folder.mailAccountId);

      while (high >= 1 && result.ingested < wanted) {
        const remaining = wanted - result.ingested;
        const low = Math.max(1, high - Math.min(batchSize, remaining) + 1);

        const batch = await fetchAndStoreSequenceBatch(
          db,
          client,
          folder,
          uidValidity,
          { low, high, fetchBodies: options.fetchBodies },
          account?.emailAddress ?? "",
          account?.serverKind ?? null,
        );
        result.ingested += batch.length;
        result.created += batch.filter((message) => message.created).length;
        await options.onBatch?.(batch);

        high = low - 1;
      }
    }

    // `high` only reaches 0 once every sequence number down to 1 has been
    // walked — an `options.limit` narrower than the folder leaves `high`
    // positive, and that's the resume point a later call (or #36's bounded
    // walker, `sync/backfill.ts`) picks up from. Nothing currently passes
    // `limit` in production; every real caller finishes the whole folder.
    await db
      .update(folders)
      .set({
        backfillCursorSeq: Math.max(0, high),
        backfillComplete: high <= 0,
        updatedAt: new Date(),
      })
      .where(eq(folders.id, folder.id));

    return result;
  } finally {
    lock.release();
  }
}

/**
 * Fetches and stores one sequence-number range, newest message first —
 * `ingestFolder`'s own per-batch step, factored out so #36's resumable
 * backfill walker (`sync/backfill.ts`) can drive the exact same fetch shape
 * and storage path one bounded batch at a time instead of the unbounded loop
 * above.
 *
 * `mailAccountEmailAddress` is what #103's Alias resolution needs
 * (`storeMessage`) — an empty string is a safe "resolve nothing" input
 * (`gatekeeper/alias.ts#resolveRecipientAlias` returns `null` for an address
 * with no parseable domain), so a caller that can't find the account row
 * degrades to "no Alias resolved" rather than failing the whole batch.
 * `mailAccountServerKind` (#122) is what decides whether this FETCH also
 * asks for Gmail Labels (`buildIngestFetchQuery`) and whether `storeMessage`
 * skips a `\Draft` row on All Mail — `null` degrades to "generic", the
 * pre-#122 behavior.
 */
export async function fetchAndStoreSequenceBatch(
  db: Db,
  client: ImapFlow,
  folder: FolderRow,
  uidValidity: number,
  range: { low: number; high: number; fetchBodies?: boolean },
  mailAccountEmailAddress: string,
  mailAccountServerKind: MailAccountServerKind | null = null,
): Promise<IngestedMessage[]> {
  const fetched = await client.fetchAll(
    `${range.low}:${range.high}`,
    buildIngestFetchQuery(folder, mailAccountServerKind),
  );

  // `fetchAll` answers in ascending sequence order; the newest message in
  // the batch is the last one, and newest-first is the contract.
  const newestFirst = fetched.reverse();
  const batch: IngestedMessage[] = [];
  for (const message of newestFirst) {
    const stored = await storeMessage(
      db,
      folder,
      uidValidity,
      message,
      mailAccountEmailAddress,
      mailAccountServerKind,
    );
    if (stored) batch.push(stored);
  }

  if (range.fetchBodies) {
    await fetchBodiesFor(db, client, newestFirst, batch);
  }

  await refreshThreadRollups(
    db,
    batch.map((message) => message.threadId),
  );

  // The Correspondent aggregate's prune (#49) runs once per batch rather
  // than once per message — see `correspondents.ts#capCorrespondents`'s own
  // doc comment for why that's cheap even so.
  if (batch.some((message) => message.created)) {
    await capCorrespondents(db, folder.mailAccountId);
  }

  return batch;
}

/**
 * A changed UIDVALIDITY means every UID this folder ever handed out is now
 * meaningless (RFC 3501 §2.3.1.1). Keeping the rows would silently point
 * stored messages at whatever now happens to hold those UIDs, so the folder
 * is emptied and re-ingested — the storage-layer form of ADR-0011's
 * `reset: true`.
 *
 * Bumps the account's `threadsEpoch` (#37, `db/schema.ts`) rather than
 * relying on `deleteEmptyThreads`' per-Thread tombstones alone: a rebuild
 * this size can plausibly outrun any one `/sync` response's entity cap, and
 * ADR-0011 names exactly this case ("the underlying state was rebuilt") as a
 * `reset: true`, not a `destroyed` list to page through.
 */
export async function applyUidValidity(
  db: Db,
  folder: FolderRow,
  uidValidity: number,
): Promise<boolean> {
  if (folder.uidValidity === null || folder.uidValidity === uidValidity) return false;

  await db.delete(messages).where(eq(messages.folderId, folder.id));
  await deleteEmptyThreads(db, folder.mailAccountId);
  await bumpThreadsEpoch(db, folder.mailAccountId);
  return true;
}

/**
 * Upserts one fetched message and resolves its Thread. Exported for
 * `sync/delta.ts` (#35): a new UID discovered by the UID-diff fallback goes
 * through exactly this path rather than a second copy of it, so a message
 * ingested via a delta and one ingested via a full pass are indistinguishable
 * rows.
 *
 * `mailAccountEmailAddress` is #103's own addition — every caller passes the
 * Mail Account's own address (or `""` when it can't be found, which resolves
 * no Alias rather than failing the store) so `resolveRecipientAlias` can tell
 * an Alias of this mailbox's own domain apart from an ordinary co-recipient.
 *
 * `mailAccountServerKind` (#122) is `null` by default (every pre-#122 caller
 * — a generic account's ingest is unchanged). On Gmail's All Mail it does
 * two things: stores whatever Gmail Labels the FETCH carried
 * (`buildIngestFetchQuery`), and skips the row entirely when it is `\Draft`
 * — ADR-0020: the Drafts Folder syncs that message in its own right, and the
 * draft-push loop already owns it, so a second All Mail copy would be a
 * message with nothing to thread against and no Optimistic Action of its
 * own. Returns `null` for a skipped row rather than a stored one.
 */
export async function storeMessage(
  db: Db,
  folder: FolderRow,
  uidValidity: number,
  fetched: FetchMessageObject,
  mailAccountEmailAddress: string,
  mailAccountServerKind: MailAccountServerKind | null = null,
): Promise<IngestedMessage | null> {
  const flags = [...(fetched.flags ?? [])];
  if (folder.role === "all" && mailAccountServerKind === "gmail" && flags.includes("\\Draft")) {
    return null;
  }

  const envelope = fetched.envelope ?? {};
  const receivedAt = toDate(fetched.internalDate) ?? toDate(envelope.date) ?? new Date();
  const sentAt = toDate(envelope.date) ?? receivedAt;

  const messageIdHeader = normalizeMessageId(envelope.messageId);
  const inReplyTo = normalizeMessageId(envelope.inReplyTo);
  const references = extractReferencesHeader(fetched.headers);

  const parts = readBodyParts(fetched.bodyStructure);
  const from = toAddresses(envelope.from)[0] ?? null;
  const to = toAddresses(envelope.to);
  const cc = toAddresses(envelope.cc);
  const recipientAlias = resolveRecipientAlias({
    mailAccountEmailAddress,
    headerBlock: fetched.headers,
    toAddresses: to,
    ccAddresses: cc,
  });

  const threadId = await resolveThread(db, {
    mailAccountId: folder.mailAccountId,
    threadingIds: threadingIdsFor({ messageId: messageIdHeader, inReplyTo, references }),
    subject: envelope.subject ?? null,
    receivedAt,
  });

  const values = {
    mailAccountId: folder.mailAccountId,
    threadId,
    folderId: folder.id,
    uid: fetched.uid,
    uidValidity,
    messageIdHeader,
    inReplyTo,
    references,
    subject: envelope.subject ?? "",
    fromName: from?.name ?? null,
    fromAddress: from?.address ?? null,
    toAddresses: to,
    ccAddresses: cc,
    replyToAddresses: toAddresses(envelope.replyTo),
    recipientAlias,
    sentAt,
    receivedAt,
    // The two Protocol Features (ADR-0006), mapped straight off the IMAP
    // flags so a User's existing read state and Stars are there on first sync.
    seen: flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    answered: flags.includes("\\Answered"),
    draft: flags.includes("\\Draft"),
    flags,
    // Gmail Labels (#122): present only when `buildIngestFetchQuery` asked
    // for them (All Mail, on a Gmail account) and the server answered —
    // `null` everywhere else, never an empty array, so a message that
    // simply isn't on Gmail stays distinguishable from one Gmail said
    // carries no labels at all.
    gmailLabels: fetched.labels ? [...fetched.labels] : null,
    sizeBytes: fetched.size ?? null,
    hasAttachments: hasRealAttachments(parts.attachments),
    attachments: parts.attachments,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(messages)
    .values({ id: randomUUID(), ...values })
    .onConflictDoUpdate({
      target: [messages.folderId, messages.uid],
      // Body columns and the Snippet are deliberately absent: re-ingesting a
      // folder refreshes what IMAP owns and never discards a fetched body or
      // re-derives a Snippet (CONTEXT.md: derived once).
      set: values,
    })
    // Postgres leaves `xmax` at 0 on a genuine insert and sets it on the
    // update branch of an upsert — the only way to tell the two apart in one
    // statement, and what "zero duplicated messages" is measured with.
    .returning({ id: messages.id, created: sql<boolean>`(xmax = 0)`.as("created") });

  if (!row) {
    throw new Error(`Upsert of message uid ${fetched.uid} in ${folder.path} returned no row`);
  }

  // The Search Index (#50, ADR-0016): written alongside the message on
  // every upsert, insert or update alike — a re-ingest can change the
  // subject/participants/attachments a stale `doc` would otherwise keep
  // ranking against. `sync/search-index.ts#reindexMessages` always
  // recomputes the whole document from this row's *current* state, so this
  // single call site is correct for both branches.
  await reindexMessages(db, [row.id]);

  // Correspondent activity (#49) is recorded exactly once per message ever
  // stored — see `correspondents.ts`'s own doc comment for why gating on
  // `created` (never on the update branch, which only means a re-ingest
  // refreshed flags/headers) is what makes this exactly-once with no ledger.
  // The one exception: a Sent-role folder's own message may already have
  // been counted at send time (`compose/send-sweeper.ts`), in which case
  // this ordinary poll ingesting the `Sent` copy back must not count it
  // again — `wasRecordedAtSend` is that check.
  if (row.created) {
    const alreadyCounted =
      folder.role === "sent" &&
      messageIdHeader !== null &&
      (await wasRecordedAtSend(db, folder.mailAccountId, messageIdHeader));
    if (!alreadyCounted) {
      await recordCorrespondentActivity(
        db,
        folder.mailAccountId,
        activityForMessage(folder.role, {
          fromAddress: values.fromAddress
            ? { name: values.fromName, address: values.fromAddress }
            : null,
          toAddresses: values.toAddresses,
          ccAddresses: values.ccAddresses,
          sentAt: values.sentAt,
          receivedAt: values.receivedAt,
        }),
      );
    }
  }

  return { id: row.id, threadId, uid: fetched.uid, receivedAt, created: row.created };
}

/**
 * Fetches bodies for a batch that has just been stored. Sequential on
 * purpose: they share the one connection ADR-0005 gives the account, and
 * ImapFlow serializes commands on it anyway — issuing them in parallel only
 * queues them somewhere less visible.
 */
async function fetchBodiesFor(
  db: Db,
  client: ImapFlow,
  fetchedBatch: FetchMessageObject[],
  stored: IngestedMessage[],
): Promise<void> {
  const idByUid = new Map(stored.map((message) => [message.uid, message.id]));
  for (const fetched of fetchedBatch) {
    const parts = readBodyParts(fetched.bodyStructure);
    if (!parts.textPart && !parts.htmlPart) continue;
    const messageId = idByUid.get(fetched.uid);
    if (!messageId) continue;

    const body = await fetchMessageBody(client, fetched.uid, parts);
    await storeMessageBody(db, messageId, body);
  }
}

function toAddresses(list: MessageAddressObject[] | undefined): MessageAddress[] {
  if (!list) return [];
  const out: MessageAddress[] = [];
  for (const entry of list) {
    // A group syntax address (`undisclosed-recipients:;`) has a name and no
    // address; it identifies nobody, so it is not a participant.
    if (!entry.address) continue;
    out.push({ name: entry.name?.trim() || null, address: entry.address.trim() });
  }
  return out;
}

function toDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
