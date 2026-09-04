import type { Db } from "../db/client.js";
import { isGmailAccount, type MailAccountServerKind } from "../mail-accounts/server-kind.js";
import { type FolderRole, type FolderRow, listSelectableFolders } from "./folders.js";

/**
 * Which Folders a Mail Account's sync actually touches (#122, ADR-0020).
 *
 * A generic account syncs every selectable Folder — nothing changes there.
 * A Gmail account stores its archive exactly once, in `[Gmail]/All Mail`:
 * every other IMAP folder Gmail exposes (the Inbox, Sent, and every user
 * Gmail Label) is the *same* mail seen a second, third, fourth time, plus
 * whatever Gmail's own housekeeping Folders (Important, Categories, Chats)
 * add on top. Only All Mail, Spam, Trash and Drafts are ever synced there —
 * `sync/folders.ts#persistFolders` still records every other Folder's role,
 * so the data exists if a later slice needs it, but this is the one seam
 * that decides what actually gets backfilled, polled, watched and ingested.
 */
export const GMAIL_SYNCED_ROLES: readonly FolderRole[] = ["all", "junk", "trash", "drafts"];
const GMAIL_SYNCED_ROLE_SET: ReadonlySet<FolderRole> = new Set(GMAIL_SYNCED_ROLES);

export function resolveSyncPlan(
  serverKind: MailAccountServerKind,
  folders: FolderRow[],
): FolderRow[] {
  const selectable = folders.filter((folder) => folder.selectable);
  if (!isGmailAccount(serverKind)) return selectable;
  return selectable.filter(
    (folder) => folder.role !== null && GMAIL_SYNCED_ROLE_SET.has(folder.role),
  );
}

/** Every live Folder the sync plan covers, in `folders.ts`'s own priority order. */
export async function listSyncPlanFolders(
  db: Db,
  mailAccountId: string,
  serverKind: MailAccountServerKind,
): Promise<FolderRow[]> {
  const selectable = await listSelectableFolders(db, mailAccountId);
  return resolveSyncPlan(serverKind, selectable);
}

/**
 * The one Folder a live session holds IDLE on: All Mail on Gmail, since new
 * mail (and every Inbox-Label add/remove) lands there at the same instant
 * (ADR-0020); INBOX everywhere else. Everything else the sync plan covers is
 * polled instead (`live-session.ts`'s resident loop).
 */
export function resolveWatchFolder(
  serverKind: MailAccountServerKind,
  plan: FolderRow[],
): FolderRow | null {
  const role: FolderRole = isGmailAccount(serverKind) ? "all" : "inbox";
  return plan.find((folder) => folder.role === role) ?? null;
}
