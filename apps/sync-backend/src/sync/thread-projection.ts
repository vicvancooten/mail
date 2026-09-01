import type { Composition, Correspondent, Label, Thread } from "@mail/shared";
import type { CompositionRow, CorrespondentRow, LabelRow } from "../db/schema.js";
import type { ThreadRow } from "./threading.js";

/** Maps a stored Thread row to ADR-0011's wire projection — the list row, never a Message body. */
export function toWireThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    mailAccountId: row.mailAccountId,
    subject: row.subject,
    participants: row.participants,
    snippet: row.snippet,
    lastMessageId: row.lastMessageId,
    firstMessageAt: row.firstMessageAt?.toISOString() ?? null,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    messageCount: row.messageCount,
    unreadCount: row.unreadCount,
    starred: row.starred,
    hasAttachments: row.hasAttachments,
    inInbox: row.inInbox,
    pinned: row.pinned,
    labelIds: row.labelIds,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Maps a stored Label row (#43) to ADR-0011's wire projection. */
export function toWireLabel(row: LabelRow): Label {
  return {
    id: row.id,
    mailAccountId: row.mailAccountId,
    name: row.name,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Maps a stored Correspondent row (#49) to ADR-0011's wire projection. */
export function toWireCorrespondent(row: CorrespondentRow): Correspondent {
  return {
    id: row.id,
    mailAccountId: row.mailAccountId,
    address: row.address,
    name: row.name,
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
    lastSeenAt: row.lastSeenAt.toISOString(),
    score: row.score,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Maps a stored Composition row (#46) to ADR-0011's wire projection. The
 * whole document rides it — see `@mail/shared`'s `compositionSchema` for why
 * a Pending Send visible on another device needs the content, not just the
 * countdown. The IMAP-push bookkeeping columns (`imapDraftUid`,
 * `pushedContentHash`) and the retry columns (`sendAttempts`,
 * `nextAttemptAt`) deliberately do not: they are the Sync Backend's own
 * business, and nothing a Client renders depends on them.
 */
export function toWireComposition(row: CompositionRow): Composition {
  return {
    id: row.id,
    mailAccountId: row.mailAccountId,
    status: row.status,
    subject: row.subject,
    document: row.document,
    to: row.toAddresses,
    cc: row.ccAddresses,
    bcc: row.bccAddresses,
    inReplyTo: row.inReplyTo,
    references: row.references,
    version: row.version,
    submitAfter: row.submitAfter?.toISOString() ?? null,
    sendError: row.sendError,
    messageId: row.messageId,
    sentAt: row.sentAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    attachments: row.attachments,
  };
}
