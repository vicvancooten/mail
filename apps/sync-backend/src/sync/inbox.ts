import { eq, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, messages } from "../db/schema.js";
import type { FolderRole } from "./folders.js";

/**
 * Gmail's own literal `X-GM-LABELS` values for its Inbox/Sent pseudo-labels
 * — matched literally rather than by role, the same way every Gmail Label
 * string is (`gmail-labels.ts`'s own doc comment). The one seam so
 * `gmail-labels.ts#SYSTEM_GMAIL_LABEL_NAMES` (#126) — its own superset of
 * every Gmail system pseudo-label — names these two off this file instead of
 * re-typing them.
 */
export const GMAIL_INBOX_LABEL = "\\Inbox";
export const GMAIL_SENT_LABEL = "\\Sent";

/**
 * The Inbox predicate (#122, ADR-0020, CONTEXT.md §Inbox): "this message is
 * in the Inbox", the one seam every consumer — this ticket's Thread
 * projection, and later Gatekeeper, the Notifier and Done — asks instead of
 * each re-deriving "arrived in / left the Inbox" from a folder role that
 * means something different per provider.
 *
 * On a generic account the Inbox is the Folder with role `"inbox"`. Gmail
 * never syncs one (ADR-0020: the Inbox is a Gmail Label, not a Folder), so
 * `gmailLabels` is what a message ingested from Gmail's All Mail carries
 * instead — `\Inbox` in that set means the same thing `role === "inbox"`
 * means everywhere else. A non-Gmail message never has `gmailLabels`
 * (`sync/ingest.ts` only ever fetches them off All Mail), so the second
 * check is always false there and this reduces to the folder-role rule
 * alone.
 */
export function isInInbox(
  folderRole: FolderRole | null,
  gmailLabels: readonly string[] | null | undefined,
): boolean {
  if (folderRole === "inbox") return true;
  return (gmailLabels ?? []).includes(GMAIL_INBOX_LABEL);
}

/**
 * The Sent predicate (#123, ADR-0020): "this message was sent by the User",
 * the seam the Thread rollup's `hasSentMessage` cue and the Correspondent
 * sent-copy dedupe both ask instead of re-deriving it from a folder role.
 *
 * On a generic account a sent message lives in the Folder with role
 * `"sent"`. Gmail never syncs one (ADR-0020: Gmail files the SMTP-submitted
 * copy into All Mail, not a synced Sent folder), so `gmailLabels` is what a
 * message ingested from Gmail's All Mail carries instead — `\Sent` in that
 * set means the same thing `role === "sent"` means everywhere else.
 */
export function isSentMessage(
  folderRole: FolderRole | null,
  gmailLabels: readonly string[] | null | undefined,
): boolean {
  if (folderRole === "sent") return true;
  return (gmailLabels ?? []).includes(GMAIL_SENT_LABEL);
}

/** The wire-facing states a Thread's Gmail projection resolves to — `threads.folderRole`'s own enum, minus `"all"`. */
export type GmailThreadFolderRole = "inbox" | "archive" | "trash" | "junk";

export interface GmailThreadStatus {
  folderRole: GmailThreadFolderRole;
  inInbox: boolean;
}

/**
 * The Thread projection on Gmail (#122, ADR-0020): "in Trash Folder → trash,
 * in Spam Folder → junk, `\Inbox` → inbox, otherwise archive" — Trash and
 * Spam win regardless of any label a message happens to carry (Gmail keeps
 * labels on a trashed/spammed message), because which real Folder holds the
 * message is the stronger signal for those two. Everything else is read
 * through `isInInbox`: labelled, it's the Inbox; not labelled, it's Archive
 * — CONTEXT.md's "All Mail without the Inbox Gmail Label".
 */
export function projectGmailThreadStatus(
  folderRole: FolderRole | null,
  gmailLabels: readonly string[] | null | undefined,
): GmailThreadStatus {
  if (folderRole === "trash") return { folderRole: "trash", inInbox: false };
  if (folderRole === "junk") return { folderRole: "junk", inInbox: false };
  if (isInInbox(folderRole, gmailLabels)) return { folderRole: "inbox", inInbox: true };
  return { folderRole: "archive", inInbox: false };
}

/**
 * The Inbox-resident subset of Messages matching `where` — the join-`folders`
 * -then-filter-by-`isInInbox` shape `sync/mutations.ts#inboxResidentMessageIds`,
 * `sync/bulk-triage.ts#applyDone`, `gatekeeper/decisions.ts#trashHeldThreads`
 * and `gatekeeper/screening.ts#moveOnArrival` each independently repeated
 * (#124, #125, ADR-0020) before this was pulled out. `where` is each
 * caller's own scope — one Thread, several Threads, or a Thread minus the
 * arrivals just enqueued — the join and the residency filter are the part
 * that never varies.
 */
export async function selectInboxResidentMessageIds(
  db: Db,
  where: SQL | undefined,
): Promise<string[]> {
  const candidates = await db
    .select({ id: messages.id, folderRole: folders.role, gmailLabels: messages.gmailLabels })
    .from(messages)
    .innerJoin(folders, eq(messages.folderId, folders.id))
    .where(where);
  return candidates
    .filter((row) => isInInbox(row.folderRole, row.gmailLabels))
    .map((row) => row.id);
}
