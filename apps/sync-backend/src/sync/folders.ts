import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ImapFlow, ListResponse } from "imapflow";
import type { Db } from "../db/client.js";
import { folders } from "../db/schema.js";

/**
 * Folder discovery and persistence (#34).
 *
 * The Sync Backend never hardcodes folder names: which mailbox is Trash on a
 * given server is the server's answer (SPECIAL-USE, XLIST, or ImapFlow's
 * localized-name matching), and it differs across the providers the PoC
 * targets. `folders.role` is where that answer is recorded once so no other
 * code has to ask again.
 */

export type FolderRow = typeof folders.$inferSelect;
export type FolderRole = NonNullable<FolderRow["role"]>;

const ROLE_BY_SPECIAL_USE: Record<string, FolderRole> = {
  "\\Inbox": "inbox",
  "\\All": "all",
  "\\Archive": "archive",
  "\\Drafts": "drafts",
  "\\Flagged": "flagged",
  "\\Junk": "junk",
  "\\Sent": "sent",
  "\\Trash": "trash",
};

/**
 * The order folders are synced in. Inbox first because it is the only view
 * the User is actually waiting on; Sent next because the Correspondent
 * aggregate and Gatekeeper's Approved-seeding both read from it; Trash and
 * Junk last because ADR-0016 excludes them from search by default and
 * nothing renders them until asked.
 */
const ROLE_PRIORITY: FolderRole[] = [
  "inbox",
  "sent",
  "archive",
  "drafts",
  "flagged",
  "all",
  "junk",
  "trash",
];

export function roleForSpecialUse(specialUse: string | undefined): FolderRole | null {
  if (!specialUse) return null;
  return ROLE_BY_SPECIAL_USE[specialUse] ?? null;
}

/**
 * INBOX is case-insensitive and mandatory in IMAP but not every server tags
 * it with the non-standard `\Inbox` flag, so the path is the fallback.
 */
function roleForListing(entry: ListResponse): FolderRole | null {
  const fromFlag = roleForSpecialUse(entry.specialUse);
  if (fromFlag) return fromFlag;
  return entry.path.toUpperCase() === "INBOX" ? "inbox" : null;
}

export interface DiscoveredFolder {
  path: string;
  name: string;
  delimiter: string | null;
  role: FolderRole | null;
  subscribed: boolean;
  selectable: boolean;
}

/** Reads the server's folder list. Pure translation — no database access. */
export async function discoverFolders(client: ImapFlow): Promise<DiscoveredFolder[]> {
  const listing = await client.list();
  return listing.map((entry) => ({
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter || null,
    role: roleForListing(entry),
    // Servers answering neither LSUB nor LIST-EXTENDED report no
    // subscription state at all, and ImapFlow then reports everything as
    // subscribed — which is the right default for a client that intends to
    // sync the whole account anyway.
    subscribed: entry.subscribed !== false,
    selectable: !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent"),
  }));
}

/**
 * Writes the discovered listing to `folders`, keyed by `(mailAccountId,
 * path)`. Folders the server no longer lists are deleted, which cascades
 * their messages away — a folder that is gone from the server is gone, and
 * leaving its messages behind would show the User mail they can no longer
 * act on.
 *
 * Returns every live folder row, in `ROLE_PRIORITY` order.
 */
export async function persistFolders(
  db: Db,
  mailAccountId: string,
  discovered: DiscoveredFolder[],
): Promise<FolderRow[]> {
  const existing = await db.select().from(folders).where(eq(folders.mailAccountId, mailAccountId));
  const byPath = new Map(existing.map((row) => [row.path, row]));
  const seen = new Set<string>();
  const now = new Date();

  for (const folder of discovered) {
    seen.add(folder.path);
    const current = byPath.get(folder.path);
    if (current) {
      await db
        .update(folders)
        .set({
          name: folder.name,
          delimiter: folder.delimiter,
          role: folder.role,
          subscribed: folder.subscribed,
          selectable: folder.selectable,
          updatedAt: now,
        })
        .where(eq(folders.id, current.id));
    } else {
      await db.insert(folders).values({
        id: randomUUID(),
        mailAccountId,
        path: folder.path,
        name: folder.name,
        delimiter: folder.delimiter,
        role: folder.role,
        subscribed: folder.subscribed,
        selectable: folder.selectable,
      });
    }
  }

  for (const row of existing) {
    if (!seen.has(row.path)) {
      await db.delete(folders).where(eq(folders.id, row.id));
    }
  }

  const live = await db.select().from(folders).where(eq(folders.mailAccountId, mailAccountId));
  return sortByPriority(live);
}

/** Inbox first, then the rest of the special-use roles, then user folders alphabetically. */
export function sortByPriority<T extends { role: FolderRole | null; path: string }>(
  rows: T[],
): T[] {
  return [...rows].sort((left, right) => {
    const leftRank = left.role ? ROLE_PRIORITY.indexOf(left.role) : ROLE_PRIORITY.length;
    const rightRank = right.role ? ROLE_PRIORITY.indexOf(right.role) : ROLE_PRIORITY.length;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.path.localeCompare(right.path);
  });
}

export async function findFolderByRole(
  db: Db,
  mailAccountId: string,
  role: FolderRole,
): Promise<FolderRow | null> {
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.mailAccountId, mailAccountId), eq(folders.role, role)))
    .limit(1);
  return row ?? null;
}

/** Every live, selectable folder for a Mail Account, in `ROLE_PRIORITY` order — what the resident sync loop (#35) polls. */
export async function listSelectableFolders(db: Db, mailAccountId: string): Promise<FolderRow[]> {
  const rows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.mailAccountId, mailAccountId), eq(folders.selectable, true)));
  return sortByPriority(rows);
}
