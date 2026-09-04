import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, messages, type ThreadParticipant, threads } from "../db/schema.js";

/**
 * Recomputes the denormalized columns on `threads` (#34).
 *
 * They are denormalized because ADR-0011's Thread projection *is* the list
 * row and `docs/poc-scope.md` puts <1s cold start and <200ms search against
 * an 80k-thread corpus — re-aggregating a Thread's messages per rendered row
 * does not survive that. The cost of that choice is exactly one rule: this
 * is the only writer, and every path that changes a message calls it.
 *
 * Two round trips per batch, not per Thread: one read of every affected
 * Thread's messages, one bulk write back through `jsonb_to_recordset`.
 */

/** The message columns a Thread rollup reads. Deliberately excludes bodies — they are wide and toasted. */
const ROLLUP_COLUMNS = {
  id: messages.id,
  threadId: messages.threadId,
  subject: messages.subject,
  snippet: messages.snippet,
  fromName: messages.fromName,
  fromAddress: messages.fromAddress,
  receivedAt: messages.receivedAt,
  uid: messages.uid,
  seen: messages.seen,
  flagged: messages.flagged,
  hasAttachments: messages.hasAttachments,
  // Sent (#74): a real signal, not an app-owned flag like `folderRole` —
  // whether *this* Message currently sits in the account's real `\Sent`
  // folder, per its own `folderId`'s join to `folders.role`.
  folderRole: folders.role,
} as const;

interface RollupRow {
  id: string;
  subject: string;
  snippet: string | null;
  participants: ThreadParticipant[];
  message_count: number;
  unread_count: number;
  starred: boolean;
  has_attachments: boolean;
  has_sent_message: boolean;
  first_message_at: string;
  last_message_at: string;
  last_message_id: string;
}

/**
 * Recomputes `threads` for every id given. A Thread with no messages left is
 * skipped rather than zeroed — `deleteEmptyThreads` removes those, and
 * writing a zeroed row first would flash an empty conversation into any
 * Client syncing between the two statements.
 */
export async function refreshThreadRollups(db: Db, threadIds: string[]): Promise<void> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return;

  const rows = await db
    .select(ROLLUP_COLUMNS)
    .from(messages)
    .innerJoin(folders, eq(folders.id, messages.folderId))
    .where(inArray(messages.threadId, ids));
  if (rows.length === 0) return;

  const byThread = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const bucket = byThread.get(row.threadId);
    if (bucket) bucket.push(row);
    else byThread.set(row.threadId, [row]);
  }

  const payload: RollupRow[] = [];
  for (const [threadId, threadMessages] of byThread) {
    // Oldest first, UID as the tie-break so two messages sharing an
    // INTERNALDATE (a bulk import, a corpus load) still order stably.
    const ordered = [...threadMessages].sort(
      (left, right) =>
        left.receivedAt.getTime() - right.receivedAt.getTime() || left.uid - right.uid,
    );
    const oldest = ordered[0];
    const newest = ordered[ordered.length - 1];
    if (!oldest || !newest) continue;

    payload.push({
      id: threadId,
      // The Thread is labelled by the conversation's opening subject, not by
      // whatever the last reply mangled it into.
      subject: oldest.subject,
      // The Snippet shown on the list row is the newest message's, and is
      // null while that message's body is still behind the Index Watermark.
      snippet: newest.snippet,
      participants: collectParticipants(ordered),
      message_count: ordered.length,
      unread_count: ordered.filter((row) => !row.seen).length,
      starred: ordered.some((row) => row.flagged),
      has_attachments: ordered.some((row) => row.hasAttachments),
      has_sent_message: ordered.some((row) => row.folderRole === "sent"),
      first_message_at: oldest.receivedAt.toISOString(),
      last_message_at: newest.receivedAt.toISOString(),
      last_message_id: newest.id,
    });
  }

  if (payload.length === 0) return;

  await db.execute(sql`
    update ${threads} as t set
      subject = v.subject,
      participants = v.participants,
      snippet = v.snippet,
      last_message_id = v.last_message_id,
      first_message_at = v.first_message_at,
      last_message_at = v.last_message_at,
      message_count = v.message_count,
      unread_count = v.unread_count,
      starred = v.starred,
      has_attachments = v.has_attachments,
      has_sent_message = v.has_sent_message,
      updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as v(
      id text,
      subject text,
      participants jsonb,
      snippet text,
      last_message_id text,
      first_message_at timestamptz,
      last_message_at timestamptz,
      message_count integer,
      unread_count integer,
      starred boolean,
      has_attachments boolean,
      has_sent_message boolean
    )
    where t.id = v.id
  `);
}

/**
 * Distinct `From` participants, oldest message first. This is the list row's
 * name column, so order is "who started this and who joined", not
 * alphabetical — and one address appears once however often they wrote.
 */
function collectParticipants(
  ordered: { fromName: string | null; fromAddress: string | null }[],
): ThreadParticipant[] {
  const byAddress = new Map<string, ThreadParticipant>();
  for (const row of ordered) {
    if (!row.fromAddress) continue;
    const key = row.fromAddress.toLowerCase();
    const existing = byAddress.get(key);
    if (!existing) {
      byAddress.set(key, { name: row.fromName, address: row.fromAddress });
    } else if (!existing.name && row.fromName) {
      // A later message carrying a display name fills in one that arrived
      // as a bare address.
      existing.name = row.fromName;
    }
  }
  return [...byAddress.values()];
}
