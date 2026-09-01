import type { Label, Thread } from "@mail/shared";
import type { LabelRow } from "../db/schema.js";
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
