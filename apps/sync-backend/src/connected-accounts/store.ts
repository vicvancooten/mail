import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connectedAccountFacets, connectedAccounts } from "../db/schema.js";
import type { ConnectedAccountCredential } from "./credential-crypto.js";

export type ConnectedAccountRow = typeof connectedAccounts.$inferSelect;
export type ConnectedAccountFacetRow = typeof connectedAccountFacets.$inferSelect;

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
