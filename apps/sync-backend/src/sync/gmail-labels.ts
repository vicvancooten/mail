import { gmailLabelId } from "@mail/shared";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { gmailLabels } from "../db/schema.js";
import { isGmailAccount, type MailAccountServerKind } from "../mail-accounts/server-kind.js";
import type { FolderRole } from "./folders.js";
import { GMAIL_INBOX_LABEL, GMAIL_SENT_LABEL } from "./inbox.js";
import { GMAIL_SYNCED_ROLES } from "./sync-plan.js";
import { recordTombstones } from "./tombstones.js";

/**
 * The `GmailLabel` collection (#126, ADR-0020): a Gmail Mail Account's own
 * Labels, synced browsable and read-only — never merged into `labels`
 * (CONTEXT.md's Gmail Label entry, `db/schema.ts#gmailLabels`'s own doc
 * comment).
 *
 * Built from the same folder listing `sync/folders.ts#discoverFolders`
 * already performs and `persistFolders` already stores — Gmail exposes every
 * Label as an IMAP mailbox, so nothing new is fetched from the server. The
 * work here is entirely which of those listed mailboxes counts: the four
 * Gmail actually syncs as real Folders (`sync/sync-plan.ts`'s
 * `GMAIL_SYNCED_ROLES`) are not Labels, and Gmail's own housekeeping
 * mailboxes (Inbox, Sent, Starred, Important, Categories, Chats — #91 story
 * 40) are never shown even though several of them carry no recognized
 * special-use `role` (`folders.ts`'s `ROLE_BY_SPECIAL_USE` has no entry for
 * Important or Chats) and would otherwise look like an ordinary user Label.
 */

/**
 * Folder roles that mean "this mailbox is a real synced Folder or a
 * housekeeping mailbox with a recognized special-use flag", never a
 * browsable Gmail Label: `all`/`junk`/`trash`/`drafts` are the four Gmail
 * Folders themselves — imported off `sync/sync-plan.ts#GMAIL_SYNCED_ROLES`
 * rather than re-typed here, so the two lists can never drift; `inbox`/
 * `sent`/`flagged` are Inbox, Sent and Starred, each already a Wicket concept
 * of its own (CONTEXT.md) and explicitly out of scope as a listed Gmail
 * Label (#91 story 40). `archive` is included defensively — Gmail never
 * advertises it, but a mailbox that somehow did would mean the same thing
 * these do.
 */
const NEVER_A_GMAIL_LABEL_ROLE: ReadonlySet<FolderRole> = new Set([
  "inbox",
  "sent",
  "flagged",
  ...GMAIL_SYNCED_ROLES,
  "archive",
]);

/**
 * Gmail's Important and Chats mailboxes carry no special-use flag this
 * codebase recognizes, so they reach here with `role: null` — matched by
 * name instead, the same fallback `folders.ts#roleForListing` already uses
 * for INBOX. Gmail's Category tabs are matched by prefix rather than a fixed
 * name, since this codebase has never observed one exposed over IMAP and the
 * literal name is not documented anywhere trustworthy — excluded
 * defensively so a future account that does expose them doesn't leak a
 * Category tab into the sidebar as though it were a User's own filing.
 */
const NEVER_A_GMAIL_LABEL_NAME: ReadonlySet<string> = new Set(["important", "chats", "chat"]);

function isHousekeepingName(name: string): boolean {
  const lower = name.toLowerCase();
  return NEVER_A_GMAIL_LABEL_NAME.has(lower) || lower.startsWith("categor");
}

/**
 * Whether a listed mailbox is a browsable Gmail Label. Takes the same shape
 * `persistFolders` already stores (`role`, `name`, `selectable`) rather than
 * a raw `ListResponse`, so this is testable against plain fixtures with no
 * IMAP server at all — consistent with #91's "no fake IMAP server with
 * Gmail extensions is built".
 */
export interface ListedMailbox {
  role: FolderRole | null;
  name: string;
  path: string;
  selectable: boolean;
}

export function isBrowsableGmailLabel(folder: ListedMailbox): boolean {
  if (!folder.selectable) return false;
  if (folder.role !== null && NEVER_A_GMAIL_LABEL_ROLE.has(folder.role)) return false;
  return !isHousekeepingName(folder.name);
}

/**
 * Gmail's system pseudo-labels as `X-GM-LABELS` actually reports them on a
 * message (`messages.gmailLabels`, #122) — a different string space from a
 * mailbox's `role`/`name` above, matched literally rather than by role: the
 * Inbox/Sent pair rides `sync/inbox.ts`'s own constants rather than being
 * re-typed here, since that file already reads `\Inbox`/`\Sent` this same
 * literal way. The `\Category*` prefix is the same defensive Category guess
 * `isHousekeepingName` makes for a listed mailbox.
 */
const SYSTEM_GMAIL_LABEL_NAMES: ReadonlySet<string> = new Set([
  GMAIL_INBOX_LABEL,
  GMAIL_SENT_LABEL,
  "\\Draft",
  "\\Starred",
  "\\Important",
  "\\Trash",
  "\\Spam",
  "\\Chat",
]);

/**
 * Whether a raw `X-GM-LABELS` value is a browsable Gmail Label rather than
 * one of Gmail's system pseudo-labels — `isBrowsableGmailLabel`'s sibling for
 * the per-message label string `sync/thread-rollup.ts` reads off
 * `messages.gmailLabels`, so `threads.gmailLabelIds` only ever names ids the
 * `GmailLabel` collection itself also has a row for.
 */
export function isBrowsableGmailLabelName(name: string): boolean {
  if (SYSTEM_GMAIL_LABEL_NAMES.has(name)) return false;
  return !name.toLowerCase().startsWith("\\categor");
}

/**
 * Persists the `GmailLabel` collection from an already-discovered folder
 * listing (`persistFolders`'s return value — every live mailbox, Gmail's
 * housekeeping ones included). A no-op list on a non-Gmail account (or one
 * whose server kind is not yet known), which also correctly empties out any
 * rows a Mail Account keeps if its server kind is ever re-detected away from
 * `gmail` — acceptance's "a generic account's response carries an empty
 * collection" holds either way, not just for an account that was never
 * Gmail.
 *
 * Path-keyed the same way `persistFolders` is: a Label that vanishes from
 * the listing (deleted, or renamed — a rename is a new path, so the old one
 * simply stops appearing) is deleted and tombstoned; one whose path is
 * unchanged only writes when its display name actually differs, so an
 * ordinary poll that finds nothing new touches zero rows and bumps no
 * `sync_rev`.
 */
export async function persistGmailLabels(
  db: Db,
  mailAccountId: string,
  serverKind: MailAccountServerKind,
  liveFolders: ListedMailbox[],
): Promise<void> {
  const wanted = isGmailAccount(serverKind) ? liveFolders.filter(isBrowsableGmailLabel) : [];

  const existing = await db
    .select()
    .from(gmailLabels)
    .where(eq(gmailLabels.mailAccountId, mailAccountId));
  const byId = new Map(existing.map((row) => [row.id, row]));
  const seen = new Set<string>();

  for (const folder of wanted) {
    const id = gmailLabelId(mailAccountId, folder.path);
    seen.add(id);
    const current = byId.get(id);
    if (!current) {
      await db.insert(gmailLabels).values({
        id,
        mailAccountId,
        name: folder.name,
        path: folder.path,
      });
    } else if (current.name !== folder.name) {
      await db
        .update(gmailLabels)
        .set({ name: folder.name, updatedAt: new Date() })
        .where(eq(gmailLabels.id, id));
    }
  }

  const vanishedIds = existing.filter((row) => !seen.has(row.id)).map((row) => row.id);
  if (vanishedIds.length > 0) {
    await db.delete(gmailLabels).where(inArray(gmailLabels.id, vanishedIds));
    await recordTombstones(db, {
      mailAccountId,
      collection: "GmailLabel",
      entityIds: vanishedIds,
    });
  }
}
