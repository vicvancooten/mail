import { asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type MessageAddress,
  type MessageAttachment,
  messageSearch,
  messages,
} from "../db/schema.js";

/**
 * The Search Index (#50, CONTEXT.md, ADR-0016): builds and writes
 * `message_search.doc` — the one place a row's `tsvector` is ever computed.
 * Every writer (`sync/ingest.ts#storeMessage`, `sync/bodies.ts
 * #storeMessageBody`, this module's own rebuild sweep) funnels through
 * `reindexMessages` below, which always recomputes the **whole** document
 * from `messages`' current row rather than patching a weight in place — a
 * message never has a partially-stale `doc`.
 *
 * `simple` + `unaccent`, **no stemming**: a stemmed configuration is one
 * language per index, and this mailbox mixes Dutch and English inside single
 * threads. Weights:
 *
 * - **A** — subject
 * - **B** — participants: `From`/`To`/`Cc` display names and addresses
 * - **C** — address parts: every address, split on non-alphanumerics into
 *   its local-part and domain-label tokens. Postgres' parser treats
 *   `vic.van.cooten@a-insights.eu` as one atomic token — without this split,
 *   free-text `insights` or `cooten` finds nothing, and sender search would
 *   need syntax nobody remembers to type. This is the load-bearing weight.
 * - **D** — body plaintext (null until the body sweep reaches it, per the
 *   Index Watermark) plus attachment filenames, known from ingest.
 */

/**
 * Bumped only for an analyzer change (stopwords, address rules, weights) —
 * never for an ordinary message write, which always stamps the *current*
 * version. `sync/search-index-loop.ts`'s background sweep is what catches
 * every row still carrying an older value up; nothing runs it at boot.
 */
export const CURRENT_SEARCH_INDEX_VERSION = 1;

/** How many rows `reindexMessages` computes and writes in one round trip. */
const DEFAULT_REBUILD_BATCH_SIZE = 200;

interface SearchDocSourceRow {
  id: string;
  mailAccountId: string;
  threadId: string;
  folderId: string;
  sentAt: Date;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  toAddresses: MessageAddress[];
  ccAddresses: MessageAddress[];
  bodyText: string | null;
  attachments: MessageAttachment[];
}

/**
 * Weight B: every participant's display name and address, space-joined —
 * `to_tsvector` tokenizes on whitespace/punctuation regardless, so a plain
 * join is enough raw material.
 */
export function participantsText(row: {
  fromName: string | null;
  fromAddress: string | null;
  toAddresses: MessageAddress[];
  ccAddresses: MessageAddress[];
}): string {
  const parts: string[] = [];
  if (row.fromName) parts.push(row.fromName);
  if (row.fromAddress) parts.push(row.fromAddress);
  for (const addr of [...row.toAddresses, ...row.ccAddresses]) {
    if (addr.name) parts.push(addr.name);
    parts.push(addr.address);
  }
  return parts.join(" ");
}

/**
 * Weight C: every address (`From`/`To`/`Cc`) lowercased and split on
 * non-alphanumeric runs — exactly the local-part-and-domain-label tokens an
 * atomic `to_tsvector` pass would otherwise swallow whole. Splitting the
 * *whole* address (not just the local part) is what also makes a bare
 * domain like `a-insights` findable.
 */
export function addressPartsText(row: {
  fromAddress: string | null;
  toAddresses: MessageAddress[];
  ccAddresses: MessageAddress[];
}): string {
  const addresses = [
    row.fromAddress,
    ...row.toAddresses.map((addr) => addr.address),
    ...row.ccAddresses.map((addr) => addr.address),
  ].filter((addr): addr is string => Boolean(addr));

  const tokens = addresses.flatMap((addr) =>
    addr
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  return tokens.join(" ");
}

/** Weight D: body plaintext (possibly still null, per the Index Watermark) plus attachment filenames. */
export function bodyAndFilenamesText(row: {
  bodyText: string | null;
  attachments: MessageAttachment[];
}): string {
  const filenames = row.attachments
    .map((attachment) => attachment.filename)
    .filter((name): name is string => Boolean(name));
  return [row.bodyText ?? "", ...filenames].join(" ");
}

/**
 * (Re)builds and writes `message_search` for the given message ids, always
 * from `messages`' current row state — an insert, a body arriving, or a
 * rebuild sweep entry are indistinguishable calls to this one function.
 * Batched via `jsonb_to_recordset` (`sync/thread-rollup.ts`'s own pattern)
 * rather than one round trip per id, so a backfill batch or a rebuild batch
 * costs one query regardless of size.
 */
export async function reindexMessages(db: Db, messageIds: string[]): Promise<void> {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return;

  const rows = await db
    .select({
      id: messages.id,
      mailAccountId: messages.mailAccountId,
      threadId: messages.threadId,
      folderId: messages.folderId,
      sentAt: messages.sentAt,
      subject: messages.subject,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      toAddresses: messages.toAddresses,
      ccAddresses: messages.ccAddresses,
      bodyText: messages.bodyText,
      attachments: messages.attachments,
    })
    .from(messages)
    .where(inArray(messages.id, ids));
  if (rows.length === 0) return; // every id vanished (deleted) between being queued and this call

  const payload = rows.map((row: SearchDocSourceRow) => ({
    message_id: row.id,
    mail_account_id: row.mailAccountId,
    thread_id: row.threadId,
    folder_id: row.folderId,
    sent_at: row.sentAt.toISOString(),
    subject: row.subject,
    participants_text: participantsText(row),
    address_parts_text: addressPartsText(row),
    body_and_filenames_text: bodyAndFilenamesText(row),
    index_version: CURRENT_SEARCH_INDEX_VERSION,
  }));

  await db.execute(sql`
    insert into ${messageSearch} (
      message_id, mail_account_id, thread_id, folder_id, sent_at, doc, index_version
    )
    select
      v.message_id, v.mail_account_id, v.thread_id, v.folder_id, v.sent_at,
      setweight(to_tsvector('simple', unaccent(coalesce(v.subject, ''))), 'A')
        || setweight(to_tsvector('simple', unaccent(coalesce(v.participants_text, ''))), 'B')
        || setweight(to_tsvector('simple', coalesce(v.address_parts_text, '')), 'C')
        || setweight(to_tsvector('simple', unaccent(coalesce(v.body_and_filenames_text, ''))), 'D'),
      v.index_version
    from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as v(
      message_id text,
      mail_account_id text,
      thread_id text,
      folder_id text,
      sent_at timestamptz,
      subject text,
      participants_text text,
      address_parts_text text,
      body_and_filenames_text text,
      index_version integer
    )
    on conflict (message_id) do update set
      mail_account_id = excluded.mail_account_id,
      thread_id = excluded.thread_id,
      folder_id = excluded.folder_id,
      sent_at = excluded.sent_at,
      doc = excluded.doc,
      index_version = excluded.index_version
  `);
}

export interface SearchIndexRebuildBatchResult {
  processed: number;
  /** True once every Message has a row and no row is left at a stale `indexVersion` — the sweep just went idle. */
  complete: boolean;
}

/**
 * One batch of the background rebuild sweep (#50, ADR-0016's "the index is
 * re-buildable without touching the mail table"): every Message with no
 * `message_search` row at all, then the oldest-version rows across every
 * Mail Account, recomputed at the current version. Never runs inside
 * `db/migrate.ts` — an analyzer bump is a code change, not a schema change,
 * and rebuilding 250k rows synchronously at boot is exactly the "startup
 * stall mid-dogfood" ADR-0009 rules out for the generated-column
 * alternative this table already avoids.
 *
 * The missing-row pass goes first, and it is what makes the claim above
 * actually true. `reindexMessages` runs at ingest (`sync/ingest.ts`) and when
 * a body lands (`sync/bodies.ts`), so a Message that was already stored
 * before this table existed (migration `0015`) — or whose ingest-time index
 * write was lost to a crash between the two statements — has no row for the
 * version sweep to find stale, and every such Message was invisible to
 * `POST /search` permanently while still sitting in the Client's own list.
 * That reads, from the Client, as "results appear and then vanish": the
 * Local Cache prefilter finds the Thread, and the authoritative server
 * answer that replaces it wholesale (ADR-0016) honestly has nothing.
 * Anti-joining `messages` against the index is the only pass that can heal
 * it, and it costs one bounded anti-join over two primary keys per tick.
 */
export async function runSearchIndexRebuildBatch(
  db: Db,
  batchSize = DEFAULT_REBUILD_BATCH_SIZE,
): Promise<SearchIndexRebuildBatchResult> {
  const missing = await db
    .select({ messageId: messages.id })
    .from(messages)
    .leftJoin(messageSearch, eq(messageSearch.messageId, messages.id))
    .where(isNull(messageSearch.messageId))
    .limit(batchSize);

  if (missing.length > 0) {
    await reindexMessages(
      db,
      missing.map((row) => row.messageId),
    );
    return { processed: missing.length, complete: false };
  }

  const pending = await db
    .select({ messageId: messageSearch.messageId })
    .from(messageSearch)
    .where(ne(messageSearch.indexVersion, CURRENT_SEARCH_INDEX_VERSION))
    .orderBy(asc(messageSearch.indexVersion))
    .limit(batchSize);

  if (pending.length === 0) return { processed: 0, complete: true };

  await reindexMessages(
    db,
    pending.map((row) => row.messageId),
  );
  return { processed: pending.length, complete: false };
}
