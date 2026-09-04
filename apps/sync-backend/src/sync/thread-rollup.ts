import { gmailLabelId } from "@mail/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, mailAccounts, messages, type ThreadParticipant, threads } from "../db/schema.js";
import { isGmailAccount } from "../mail-accounts/server-kind.js";
import { isBrowsableGmailLabelName } from "./gmail-labels.js";
import { isSentMessage, projectGmailThreadStatus } from "./inbox.js";

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
 * Thread's messages, one bulk write back through `jsonb_to_recordset`. On a
 * Gmail account (#122, ADR-0020) a third, smaller write follows: `folderRole`
 * and `inInbox` there are not `sync/mutations.ts`'s own field the way they
 * are on a generic account (its own doc comment on `threads.folderRole`
 * still applies there, unchanged) — they are read straight off
 * `sync/inbox.ts#projectGmailThreadStatus`, applied to the *newest* message
 * still in the Thread, every time this runs.
 */

/** The message columns a Thread rollup reads. Deliberately excludes bodies — they are wide and toasted. */
const ROLLUP_COLUMNS = {
  id: messages.id,
  threadId: messages.threadId,
  mailAccountId: messages.mailAccountId,
  subject: messages.subject,
  snippet: messages.snippet,
  fromName: messages.fromName,
  fromAddress: messages.fromAddress,
  receivedAt: messages.receivedAt,
  uid: messages.uid,
  seen: messages.seen,
  flagged: messages.flagged,
  hasAttachments: messages.hasAttachments,
  // Sent (#74, #123): a real signal, not an app-owned flag like `folderRole`
  // — whether *this* Message currently sits in the account's real `\Sent`
  // folder, per its own `folderId`'s join to `folders.role`, or (Gmail,
  // which never syncs one) carries the `\Sent` Gmail Label. See
  // `sync/inbox.ts#isSentMessage`.
  folderRole: folders.role,
  // Gmail Labels (#122) — null on every non-Gmail message, and on every
  // Gmail message outside All Mail (`db/schema.ts`'s own doc comment).
  gmailLabels: messages.gmailLabels,
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

  // One lookup for the whole batch, not per Thread: which of the accounts
  // these Threads belong to are Gmail decides whether `gmailProjection`
  // below applies at all — a generic account's `folderRole`/`inInbox` stay
  // exactly what they were, `sync/mutations.ts`'s own field.
  const accountIds = [...new Set(rows.map((row) => row.mailAccountId))];
  const accountRows = await db
    .select({ id: mailAccounts.id, serverKind: mailAccounts.serverKind })
    .from(mailAccounts)
    .where(inArray(mailAccounts.id, accountIds));
  const serverKindByAccount = new Map(accountRows.map((row) => [row.id, row.serverKind]));

  const byThread = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const bucket = byThread.get(row.threadId);
    if (bucket) bucket.push(row);
    else byThread.set(row.threadId, [row]);
  }

  const payload: RollupRow[] = [];
  const gmailProjection: {
    id: string;
    folder_role: string;
    in_inbox: boolean;
    gmail_label_ids: string[];
  }[] = [];
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
      has_sent_message: ordered.some((row) => isSentMessage(row.folderRole, row.gmailLabels)),
      first_message_at: oldest.receivedAt.toISOString(),
      last_message_at: newest.receivedAt.toISOString(),
      last_message_id: newest.id,
    });

    // The Thread projection on Gmail (#122, ADR-0020): resolved off the
    // newest message still in the Thread, the same "most representative of
    // where this conversation stands now" choice the Snippet above makes.
    if (isGmailAccount(serverKindByAccount.get(newest.mailAccountId))) {
      const status = projectGmailThreadStatus(newest.folderRole, newest.gmailLabels);
      // Gmail Labels (#126, ADR-0020): unlike folderRole/inInbox, membership
      // is the *union* across every Message still in the Thread, not just the
      // newest — a Gmail conversation is not always labelled identically on
      // every message, and "this Thread carries this Label" (the sidebar's
      // own question) is true the moment any message in it does, the same
      // "any message" shape `has_sent_message` above already uses.
      const gmailLabelIds = new Set<string>();
      for (const row of ordered) {
        for (const rawLabel of row.gmailLabels ?? []) {
          if (!isBrowsableGmailLabelName(rawLabel)) continue;
          gmailLabelIds.add(gmailLabelId(row.mailAccountId, rawLabel));
        }
      }
      gmailProjection.push({
        id: threadId,
        folder_role: status.folderRole,
        in_inbox: status.inInbox,
        gmail_label_ids: [...gmailLabelIds],
      });
    }
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

  if (gmailProjection.length > 0) {
    await db.execute(sql`
      update ${threads} as t set
        folder_role = v.folder_role,
        in_inbox = v.in_inbox,
        gmail_label_ids = v.gmail_label_ids,
        updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(gmailProjection)}::jsonb) as v(
        id text,
        folder_role text,
        in_inbox boolean,
        gmail_label_ids text[]
      )
      where t.id = v.id
    `);
  }
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
