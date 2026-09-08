import type { ConnectedAccount } from "@mail/shared";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connectedAccountFacets, connectedAccounts } from "../db/schema.js";
import type { ConnectedAccountCredential } from "./credential-crypto.js";

export type ConnectedAccountRow = typeof connectedAccounts.$inferSelect;
export type ConnectedAccountFacetRow = typeof connectedAccountFacets.$inferSelect;

/** A Connected Account's Facets, aggregated to the shape `ConnectedAccount.facets` (`@mail/shared`) rides the wire as. */
export interface ConnectedAccountFacetSummary {
  kind: ConnectedAccountFacetRow["kind"];
  status: ConnectedAccountFacetRow["status"];
}

/**
 * A page of one User's Connected Accounts changed since `cursorRev`, each
 * joined to its own Facets aggregated one-query rather than N+1'd per row
 * (#200) — `sync/collection-registry.ts`'s `ConnectedAccount` collection's
 * own `selectRows`, kept here rather than inlined so the join lives next to
 * the table it reads (the same division `mail-accounts/store.ts#mailAccountRowsQuery`
 * draws). `left join` + `filter (where ... is not null)`, not `inner join`:
 * an account created by the boot-time upgrade (#199, `boot-upgrade.ts`)
 * inserts its one Mail Facet in the same transaction, so an account with
 * zero Facets should never actually occur, but a `left join` degrading to
 * `facets: []` rather than silently dropping the account row is the safer
 * failure if it ever did. The caller (`collection-registry.ts`) appends its
 * own `.limit(PAGE_SIZE + 1)` — `groupBy` has to land before that in
 * Drizzle's own chain order, which is what keeps this function from taking
 * the limit as a parameter instead.
 */
export function selectConnectedAccountsForUser(db: Db, userId: string, cursorRev: number) {
  return db
    .select({
      id: connectedAccounts.id,
      userId: connectedAccounts.userId,
      provider: connectedAccounts.provider,
      identity: connectedAccounts.identity,
      status: connectedAccounts.status,
      createdAt: connectedAccounts.createdAt,
      syncRev: connectedAccounts.syncRev,
      syncCreatedRev: connectedAccounts.syncCreatedRev,
      facets: sql<ConnectedAccountFacetSummary[]>`
        coalesce(
          jsonb_agg(
            jsonb_build_object('kind', ${connectedAccountFacets.kind}, 'status', ${connectedAccountFacets.status})
            order by ${connectedAccountFacets.kind}
          ) filter (where ${connectedAccountFacets.id} is not null),
          '[]'::jsonb
        )`,
    })
    .from(connectedAccounts)
    .leftJoin(
      connectedAccountFacets,
      eq(connectedAccountFacets.connectedAccountId, connectedAccounts.id),
    )
    .where(and(eq(connectedAccounts.userId, userId), gt(connectedAccounts.syncRev, cursorRev)))
    .groupBy(connectedAccounts.id)
    .orderBy(asc(connectedAccounts.syncRev));
}

export interface ConnectedAccountSyncRow {
  id: string;
  userId: string;
  provider: ConnectedAccountRow["provider"];
  identity: string;
  status: ConnectedAccountRow["status"];
  createdAt: Date;
  syncRev: number;
  syncCreatedRev: number;
  facets: ConnectedAccountFacetSummary[];
}

/** Never includes `credential` — write-only across the API (ADR-0003), the same rule `mail-accounts/store.ts#toWireMailAccount` follows. */
export function toWireConnectedAccount(row: ConnectedAccountSyncRow): ConnectedAccount {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    identity: row.identity,
    status: row.status,
    facets: row.facets,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getConnectedAccountById(
  db: Db,
  id: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Whether a Connected Account already carries this Facet, any status (#202):
 * the guard the `add_facet` start route uses to refuse re-offering a consent
 * flow for a Facet already turned on — re-granting it is a Fix flow (#204),
 * not this one.
 */
export async function connectedAccountHasFacet(
  db: Db,
  connectedAccountId: string,
  kind: ConnectedAccountFacetRow["kind"],
): Promise<boolean> {
  const [row] = await db
    .select({ id: connectedAccountFacets.id })
    .from(connectedAccountFacets)
    .where(
      and(
        eq(connectedAccountFacets.connectedAccountId, connectedAccountId),
        eq(connectedAccountFacets.kind, kind),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Scoped by User and Provider (ADR-0022: "unique per User, Provider and
 * identity") — the duplicate check for adding a Connected Account, and the
 * lookup a boot-time upgrade or a future Facet-attach flow uses to find an
 * existing account before minting a new one.
 */
export async function getConnectedAccountForUserByIdentity(
  db: Db,
  userId: string,
  provider: ConnectedAccountRow["provider"],
  identity: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, provider),
        eq(connectedAccounts.identity, identity),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Turning on a Facet's write path (#202, ADR-0022): lands the widened
 * credential (`credential-crypto.ts#widenOAuthCredential`) and the new
 * `active` Facet row in one transaction, so a Client can never observe a
 * credential that already covers the new scope without the Facet row that
 * says so, or vice versa. `id` follows `insertMailAccount`'s own
 * `${connectedAccountId}-${kind}` convention. `scopesLastGrantedAt` is
 * stamped `now` here — the one write path that ever sets it, since the
 * boot-time upgrade's own Mail Facet (#199) never ran a consent round to
 * stamp a time for.
 */
export async function attachFacetToConnectedAccount(
  db: Db,
  connectedAccountId: string,
  kind: Exclude<ConnectedAccountFacetRow["kind"], "mail">,
  credential: ConnectedAccountCredential,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(connectedAccounts)
      .set({ credential, updatedAt: new Date() })
      .where(eq(connectedAccounts.id, connectedAccountId));
    await tx.insert(connectedAccountFacets).values({
      id: `${connectedAccountId}-${kind}`,
      connectedAccountId,
      kind,
      status: "active",
      scopesLastGrantedAt: new Date(),
    });
  });
}

/**
 * A Grant refresh's write path (#118, ADR-0022): reseals the fresh
 * credential onto an already-`active` Connected Account. Unlike
 * `reactivateConnectedAccount` below, this never touches `status` on the
 * account or either Facet — a routine token refresh is not a reauth.
 */
export async function updateConnectedAccountCredential(
  db: Db,
  id: string,
  credential: ConnectedAccountCredential,
): Promise<void> {
  await db
    .update(connectedAccounts)
    .set({ credential, updatedAt: new Date() })
    .where(eq(connectedAccounts.id, id));
}

/**
 * The seam a sync engine or a Provider Registration removal calls when the
 * mail server rejects the stored credential or the Grant is withdrawn
 * (ADR-0022: "on the Connected Account ... every Facet stops"): parks both
 * the account and every one of its Facets in Needs Reauth.
 *
 * The `status != 'needs_reauth'` guard makes this an atomic check-and-set,
 * the same shape `mail-accounts/store.ts#markNeedsReauth` (pre-#199) always
 * had: it returns the updated row only on a genuine transition, `null` when
 * the account was already parked — the distinction #53's Notifier hook needs
 * to notify once per transition, not once per failed connection.
 */
export async function markConnectedAccountNeedsReauth(
  db: Db,
  connectedAccountId: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .update(connectedAccounts)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(
      and(
        eq(connectedAccounts.id, connectedAccountId),
        ne(connectedAccounts.status, "needs_reauth"),
      ),
    )
    .returning();
  if (row) {
    await db
      .update(connectedAccountFacets)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(eq(connectedAccountFacets.connectedAccountId, connectedAccountId));
  }
  return row ?? null;
}

/**
 * Re-entering credentials (CONTEXT.md's Needs Reauth flow) resumes: a fresh
 * credential, and every Facet the account holds — Mail included — back to
 * `active`. Account-level Needs Reauth stops every Facet (ADR-0022), so
 * clearing it resumes every Facet the same way; there is no per-Facet
 * re-consent flow to run first (that's a Facet-level rejection, #204).
 *
 * `provider` is written alongside the credential rather than left as-is:
 * ADR-0022's "the Other IMAP to Google switch survives" is exactly a
 * password reauth's credential turning into a Grant — the caller (Mail's own
 * reauth flow) derives which Provider the fresh credential actually names,
 * and this is the one place that lands it on the row.
 */
export async function reactivateConnectedAccount(
  db: Db,
  connectedAccountId: string,
  provider: ConnectedAccountRow["provider"],
  credential: ConnectedAccountCredential,
): Promise<void> {
  await db
    .update(connectedAccounts)
    .set({ provider, credential, status: "active", updatedAt: new Date() })
    .where(eq(connectedAccounts.id, connectedAccountId));
  await db
    .update(connectedAccountFacets)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(connectedAccountFacets.connectedAccountId, connectedAccountId));
}
