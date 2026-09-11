import type { ConnectedAccountFacetKind } from "@mail/shared";
import { and, eq, gt, sql } from "drizzle-orm";
import { listAddressBookIdsForConnectedAccount } from "../address-books/store.js";
import { pruneContactLinkMembers } from "../contacts/link-store.js";
import type { Db, Tx } from "../db/client.js";
import {
  addressBooks,
  type ConnectedAccountFacetRow,
  type ConnectedAccountRow,
  compositions,
  connectedAccountFacets,
  connectedAccounts,
  contacts,
  mailAccounts,
  threads,
} from "../db/schema.js";
import { recordTombstones } from "../sync/tombstones.js";
import type { ConnectedAccountCredential } from "./credential-crypto.js";

/**
 * Turning off a Facet, removing a Connected Account (#206, ADR-0029:
 * "removal discards the mirror and is a confirmed act"). Both the read-only
 * preview a confirmation dialog opens with and the actual removal share the
 * same lookups — this module is where both live, the same division
 * `connected-accounts/store.ts` already draws between reads and writes.
 *
 * The Mail Facet has real data behind it (`threads`, and the Undo Send
 * window on `compositions`); Calendar still has no mirror to discard
 * (#229's own epic, not landed). Contacts (#209) is the second Facet with
 * real data: turning it off, or removing the whole account, discards that
 * account's Address Books and Contacts — see `removeConnectedAccountFacet`'s
 * own `kind === "contacts"` branch below for how.
 */

/** One Mail Facet's synced Thread count — `0` for a Facet that was never Mail, or a Mail Facet whose Mail Account has somehow already gone. */
async function countThreadsForMailAccount(db: Db, mailAccountId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(threads)
    .where(eq(threads.mailAccountId, mailAccountId));
  return row?.count ?? 0;
}

/**
 * Whole seconds until every still-cancellable Pending Send on this Mail
 * Account clears its Undo Send window (ADR-0007), `null` when none block.
 * Only `pending` rows whose `submitAfter` is still ahead of `now` count — a
 * `submitting` row is already past the point of no return (`compose/
 * pending-send.ts#cancelSend`'s own doc comment), so it never blocks a
 * removal that arrives after submission has already started.
 */
async function pendingSendBlockSeconds(
  db: Db | Tx,
  mailAccountId: string,
  now: Date,
): Promise<number | null> {
  const rows = await db
    .select({ submitAfter: compositions.submitAfter })
    .from(compositions)
    .where(
      and(
        eq(compositions.mailAccountId, mailAccountId),
        eq(compositions.status, "pending"),
        gt(compositions.submitAfter, now),
      ),
    );
  if (rows.length === 0) return null;
  const remainingMs = Math.max(
    ...rows.map((row) => (row.submitAfter as Date).getTime() - now.getTime()),
  );
  return Math.ceil(remainingMs / 1000);
}

interface ConnectedAccountFacetLookup {
  account: ConnectedAccountRow;
  facets: ConnectedAccountFacetRow[];
  facet: ConnectedAccountFacetRow;
}

/**
 * The shape both `getConnectedAccountFacetRemovalPreview` and
 * `removeConnectedAccountFacet` start from — the User's own Connected
 * Account, every Facet it carries, and the one Facet `kind` names — `null`
 * for any of the ways that doesn't exist (wrong User, wrong id, wrong
 * kind), which both callers turn into a 404.
 */
async function findConnectedAccountFacet(
  db: Db | Tx,
  userId: string,
  connectedAccountId: string,
  kind: ConnectedAccountFacetKind,
): Promise<ConnectedAccountFacetLookup | null> {
  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, connectedAccountId), eq(connectedAccounts.userId, userId)))
    .limit(1);
  if (!account) return null;

  const facets = await db
    .select()
    .from(connectedAccountFacets)
    .where(eq(connectedAccountFacets.connectedAccountId, account.id));
  const facet = facets.find((row) => row.kind === kind);
  if (!facet) return null;

  return { account, facets, facet };
}

/** The Mail Facet's own Mail Account row, `null` for a Facet that isn't Mail or whose Mail Account has somehow already gone. */
async function findMailAccountForConnectedAccount(
  db: Db | Tx,
  connectedAccountId: string,
): Promise<{ id: string } | null> {
  const [mailAccount] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(eq(mailAccounts.connectedAccountId, connectedAccountId))
    .limit(1);
  return mailAccount ?? null;
}

export interface ConnectedAccountFacetRemovalPreviewResult {
  threadCount: number;
  accountRemoved: boolean;
  pendingSendBlockSeconds: number | null;
}

/**
 * `GET /connected-accounts/:id/facets/:kind/removal-preview`'s read path —
 * `null` for a Facet that doesn't exist (wrong User, wrong id, wrong kind),
 * which the route answers 404 for.
 */
export async function getConnectedAccountFacetRemovalPreview(
  db: Db,
  userId: string,
  connectedAccountId: string,
  kind: ConnectedAccountFacetKind,
  now: Date = new Date(),
): Promise<ConnectedAccountFacetRemovalPreviewResult | null> {
  const lookup = await findConnectedAccountFacet(db, userId, connectedAccountId, kind);
  if (!lookup) return null;
  const { account, facets } = lookup;

  if (kind !== "mail") {
    return { threadCount: 0, accountRemoved: facets.length === 1, pendingSendBlockSeconds: null };
  }

  const mailAccount = await findMailAccountForConnectedAccount(db, account.id);
  if (!mailAccount) {
    return { threadCount: 0, accountRemoved: facets.length === 1, pendingSendBlockSeconds: null };
  }

  return {
    threadCount: await countThreadsForMailAccount(db, mailAccount.id),
    accountRemoved: facets.length === 1,
    pendingSendBlockSeconds: await pendingSendBlockSeconds(db, mailAccount.id, now),
  };
}

export type RemoveConnectedAccountFacetResult =
  | { status: "not_found" }
  | { status: "blocked_pending_send"; secondsRemaining: number }
  | {
      status: "removed";
      accountRemoved: boolean;
      removedMailAccountId: string | null;
      /** Only set when `accountRemoved` — the caller's own hook for a best-effort Grant revoke, done after this commits. */
      revokedCredential: ConnectedAccountCredential | null;
    };

/**
 * The actual removal (#206, ADR-0029). One transaction:
 *
 * - **The row and credential go synchronously**: the last Facet deletes the
 *   whole `connected_accounts` row (its `credential` column goes with it),
 *   cascading its Facets and, for Mail, the Mail Account and everything
 *   under it — `db/schema.ts`'s own `ON DELETE CASCADE` chain, an indexed
 *   operation Postgres runs in the one statement rather than something this
 *   ticket needs a background sweep to make bounded (docs/poc-scope.md caps
 *   an account at ~80k Threads).
 * - **Re-adding the same identity is never blocked**: `connected_accounts`'
 *   own `(user_id, provider, identity)` unique index is gone the instant
 *   this commits, well before anything downstream of the cascade could
 *   possibly still be running.
 * - **Other devices learn through the `ConnectedAccount` collection's
 *   delta** (ADR-0022's Account Scope, this ticket's own acceptance line):
 *   a `MailAccount` tombstone is enough to make the Client's own
 *   `pruneOrphanedMailAccountData` sweep (`store/server-writes.ts`) wipe
 *   every Thread/GmailLabel/Correspondent/Composition/list-window/pin under
 *   that scope on its own next sync — there is deliberately no per-Thread
 *   tombstone here, which is what keeps this transaction small regardless
 *   of how large the mirror it just discarded was.
 *
 * A non-last Facet only ever deletes its own `connected_account_facets` row
 * (and, for Mail, the Mail Account beneath it) — the account survives, so
 * its own `sync_rev` is bumped by hand: the delete above doesn't fire
 * `bump_connected_account_facet_sync_rev` (`AFTER INSERT OR UPDATE`, never
 * `DELETE`, migration 0041), so nothing would otherwise tell a Client the
 * account's `facets` array just lost an entry.
 */
export async function removeConnectedAccountFacet(
  db: Db,
  params: {
    userId: string;
    connectedAccountId: string;
    kind: ConnectedAccountFacetKind;
    now?: Date;
  },
): Promise<RemoveConnectedAccountFacetResult> {
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    const lookup = await findConnectedAccountFacet(
      tx,
      params.userId,
      params.connectedAccountId,
      params.kind,
    );
    if (!lookup) return { status: "not_found" };
    const { account, facet, facets } = lookup;

    const accountRemoved = facets.length === 1;

    let mailAccountId: string | null = null;
    if (params.kind === "mail") {
      const mailAccount = await findMailAccountForConnectedAccount(tx, account.id);
      mailAccountId = mailAccount?.id ?? null;
      if (mailAccountId) {
        const blockSeconds = await pendingSendBlockSeconds(tx, mailAccountId, now);
        if (blockSeconds !== null) {
          return { status: "blocked_pending_send", secondsRemaining: blockSeconds };
        }
      }
    }

    // Contacts under this account are about to go — by the
    // `connected_accounts` cascade below, or with their Address Books in the
    // Contacts branch further down. Either way a `ContactLink` naming one
    // can't cascade with them (#222, `db/schema.ts#contactLinks`), so the
    // links drop those members first, while the ids still exist to name.
    if (accountRemoved || params.kind === "contacts") {
      const contactRows = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.connectedAccountId, account.id));
      await pruneContactLinkMembers(
        tx,
        params.userId,
        contactRows.map((row) => row.id),
      );
    }

    if (accountRemoved) {
      // Address Books and Contacts under this account cascade-delete with
      // the `connected_accounts` row itself (`db/schema.ts`'s own `ON DELETE
      // CASCADE` chain) — no per-book tombstone needed, the same "no
      // per-Thread tombstone" reasoning this function's own doc comment
      // gives for Mail: the Client's `pruneOrphanedAddressBookData` sweep
      // (`store/server-writes.ts`) wipes anything left under a
      // `ConnectedAccount` its own tombstone (recorded right below) says is
      // gone, on its own next sync.
      await tx.delete(connectedAccounts).where(eq(connectedAccounts.id, account.id));
      await recordTombstones(tx, {
        mailAccountId: null,
        collection: "ConnectedAccount",
        entityIds: [account.id],
      });
      if (mailAccountId) {
        await recordTombstones(tx, {
          mailAccountId: null,
          collection: "MailAccount",
          entityIds: [mailAccountId],
        });
      }
    } else {
      await tx.delete(connectedAccountFacets).where(eq(connectedAccountFacets.id, facet.id));
      if (mailAccountId) {
        await tx.delete(mailAccounts).where(eq(mailAccounts.id, mailAccountId));
        await recordTombstones(tx, {
          mailAccountId: null,
          collection: "MailAccount",
          entityIds: [mailAccountId],
        });
      }
      if (params.kind === "contacts") {
        // The account survives (another Facet keeps it alive), so — unlike
        // the `accountRemoved` branch above — there is no `ConnectedAccount`
        // tombstone for the Client to infer this from; the Address Book(s)
        // need their own, real, Connected-Account-scoped tombstone (#209,
        // ADR-0029). Contacts inside them cascade-delete with their Address
        // Book and need none of their own, the same "the parent's tombstone
        // is enough" shape.
        const addressBookIds = await listAddressBookIdsForConnectedAccount(tx, account.id);
        if (addressBookIds.length > 0) {
          await tx.delete(addressBooks).where(eq(addressBooks.connectedAccountId, account.id));
          await recordTombstones(tx, {
            mailAccountId: null,
            connectedAccountId: account.id,
            collection: "AddressBook",
            entityIds: addressBookIds,
          });
        }
      }
      // Bumps `connected_accounts.sync_rev` by hand — see this function's own doc comment.
      await tx
        .update(connectedAccounts)
        .set({ updatedAt: now })
        .where(eq(connectedAccounts.id, account.id));
    }

    return {
      status: "removed",
      accountRemoved,
      removedMailAccountId: mailAccountId,
      revokedCredential: accountRemoved ? account.credential : null,
    };
  });
}
