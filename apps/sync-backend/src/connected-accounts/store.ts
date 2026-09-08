import type { ConnectedAccount, DavFacet } from "@mail/shared";
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

/** Scoped by User — ownership is the only authorization primitive (ADR-0004), the same guard `mail-accounts/store.ts#getMailAccountForUser` applies. */
export async function getConnectedAccountForUser(
  db: Db,
  userId: string,
  id: string,
): Promise<ConnectedAccountRow | null> {
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * One Facet's own row, any status — the read `connectedAccountHasFacet`
 * (below) and the `add_facet` start route's own Fix-vs-fresh-add guard
 * (#204) both build on: a Facet that doesn't exist yet is a fresh add, one
 * that exists `active` is a duplicate, one that exists `needs_reauth` is a
 * Fix.
 */
export async function getConnectedAccountFacet(
  db: Db,
  connectedAccountId: string,
  kind: ConnectedAccountFacetRow["kind"],
): Promise<ConnectedAccountFacetRow | null> {
  const [row] = await db
    .select()
    .from(connectedAccountFacets)
    .where(
      and(
        eq(connectedAccountFacets.connectedAccountId, connectedAccountId),
        eq(connectedAccountFacets.kind, kind),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether a Connected Account already carries a given Facet, any status —
 * the guard `POST /connected-accounts/:id/caldav-facets` runs before
 * discovery (#203, so turning on an already-on Facet fails fast rather than
 * re-running discovery for nothing).
 */
export async function connectedAccountHasFacet(
  db: Db,
  connectedAccountId: string,
  kind: ConnectedAccountFacetRow["kind"],
): Promise<boolean> {
  return (await getConnectedAccountFacet(db, connectedAccountId, kind)) !== null;
}

/** Every Facet a Connected Account carries — the scope-diff a Grant refresh runs (#204, `mail-accounts/grant-refresh.ts`) and this account's own CalDAV/CardDAV reauth verification both read every row rather than one Facet at a time. */
export async function listConnectedAccountFacets(
  db: Db,
  connectedAccountId: string,
): Promise<ConnectedAccountFacetRow[]> {
  return db
    .select()
    .from(connectedAccountFacets)
    .where(eq(connectedAccountFacets.connectedAccountId, connectedAccountId));
}

/** Discovery's own findings (`dav-discovery.ts#DavDiscoveryResult`'s `ok: true` branch) — what both CalDAV write paths below stamp onto a Facet row. */
export interface CalDavDiscoveryFields {
  principalUrl: string;
  homeSetUrl: string;
  supportsScheduling: boolean;
}

export interface InsertCalDavAccountInput {
  id: string;
  userId: string;
  /** The raw entered value, kept verbatim so turning on a second Facet re-runs discovery against the same input rather than a value discovery itself resolved (`serverAddress` on the Connected Account row, #203). */
  serverAddress: string;
  /** Also `connected_accounts.identity` — CalDAV/CardDAV's identity is the entered username, not the server address (`db/schema.ts#connectedAccounts`'s own doc comment). */
  username: string;
  credential: ConnectedAccountCredential;
  facet: DavFacet;
  discovery: CalDavDiscoveryFields;
}

/**
 * Creates a brand-new CalDAV/CardDAV Connected Account and its first Facet,
 * atomically (#203) — the "server address, username, app password, then
 * discovery, then the account exists" flow's write path. Mirrors
 * `mail-accounts/store.ts#insertMailAccount`'s shape (a fresh identity every
 * time this is called); turning on a *second* Facet on an account this
 * already created is `insertCalDavFacet` below, never this function again.
 */
export async function insertCalDavAccount(db: Db, input: InsertCalDavAccountInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(connectedAccounts).values({
      id: input.id,
      userId: input.userId,
      provider: "caldav_carddav",
      identity: input.username,
      credential: input.credential,
      status: "active",
      serverAddress: input.serverAddress,
      daveUsername: input.username,
    });
    await tx.insert(connectedAccountFacets).values({
      id: `${input.id}-${input.facet}`,
      connectedAccountId: input.id,
      kind: input.facet,
      status: "active",
      davPrincipalUrl: input.discovery.principalUrl,
      davHomeSetUrl: input.discovery.homeSetUrl,
      davSupportsScheduling: input.discovery.supportsScheduling,
    });
  });
}

/**
 * Turning on the second Facet on an already-connected CalDAV/CardDAV account
 * (#203's own acceptance criterion: "runs discovery only and never asks for
 * the password again") — the caller has already re-run discovery against the
 * account's existing `serverAddress`/`daveUsername` and its stored
 * credential; this just writes the new Facet row.
 */
export async function insertCalDavFacet(
  db: Db,
  connectedAccountId: string,
  facet: DavFacet,
  discovery: CalDavDiscoveryFields,
): Promise<void> {
  await db.insert(connectedAccountFacets).values({
    id: `${connectedAccountId}-${facet}`,
    connectedAccountId,
    kind: facet,
    status: "active",
    davPrincipalUrl: discovery.principalUrl,
    davHomeSetUrl: discovery.homeSetUrl,
    davSupportsScheduling: discovery.supportsScheduling,
  });
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
 * Turning on a Facet's write path (#202, ADR-0022), and — since #204 — the
 * Fix flow's write path for a Facet already parked in Needs Reauth: lands
 * the widened credential (`credential-crypto.ts#widenOAuthCredential`) and
 * the Facet row back to `active` in one transaction, so a Client can never
 * observe a credential that already covers the scope without the Facet row
 * that says so, or vice versa. `onConflictDoUpdate` rather than a plain
 * insert is exactly what makes both callers the same function: a fresh
 * Facet inserts, an already-existing (`needs_reauth`) one updates in place,
 * keeping its `id` and every other row this account already carries. `id`
 * follows `insertMailAccount`'s own `${connectedAccountId}-${kind}`
 * convention for the insert case. `scopesLastGrantedAt` is stamped `now` on
 * both paths — the one write path that ever sets it, since the boot-time
 * upgrade's own Mail Facet (#199) never ran a consent round to stamp a time
 * for.
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
    await tx
      .insert(connectedAccountFacets)
      .values({
        id: `${connectedAccountId}-${kind}`,
        connectedAccountId,
        kind,
        status: "active",
        scopesLastGrantedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [connectedAccountFacets.connectedAccountId, connectedAccountFacets.kind],
        set: { status: "active", scopesLastGrantedAt: new Date(), updatedAt: new Date() },
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
 * (ADR-0022: "on the Connected Account ... every Facet stops") — the
 * account-level half of Needs Reauth's two levels (#204). Parks both the
 * account and every one of its Facets, even one already parked on its own
 * for an unrelated reason (a Facet-level park is strictly subsumed by an
 * account-level one). The Facet-level half, parking exactly one Facet and
 * leaving the account and its other Facets untouched, is
 * `markConnectedAccountFacetNeedsReauth` below.
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

/**
 * The Facet-level half of Needs Reauth's two levels (#204, ADR-0022: "on a
 * single Facet when only its consent is refused ... that Facet stops, the
 * others continue"): parks exactly one Facet, never touching the account
 * row or any other Facet. `mail-accounts/store.ts#markNeedsReauth` is the
 * caller for a Mail Facet's own rejection; `grant-refresh.ts` is the caller
 * for a Grant refresh that comes back missing an active Facet's scope.
 *
 * Same atomic check-and-set shape as `markConnectedAccountNeedsReauth`:
 * `status != 'needs_reauth'` makes this a genuine-transition-only update,
 * returning the updated row only when one actually happened — the Notifier
 * hook's "once per transition" guarantee (#53, ADR-0015).
 */
export async function markConnectedAccountFacetNeedsReauth(
  db: Db,
  connectedAccountId: string,
  kind: ConnectedAccountFacetRow["kind"],
): Promise<ConnectedAccountFacetRow | null> {
  const [row] = await db
    .update(connectedAccountFacets)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(
      and(
        eq(connectedAccountFacets.connectedAccountId, connectedAccountId),
        eq(connectedAccountFacets.kind, kind),
        ne(connectedAccountFacets.status, "needs_reauth"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Resumes exactly one Facet, the Fix flow's write path for a Facet-level
 * park (#204) — never touches the account row or any other Facet, unlike
 * `reactivateConnectedAccount` above. The OAuth Fix (re-granting the Facet's
 * own scope) resumes through `attachFacetToConnectedAccount`'s upsert
 * instead, which lands the widened credential and the `active` status in
 * one transaction; this function is for a Fix that never touches the
 * credential at all — there is none today (every Facet-level park is
 * OAuth-only, ADR-0022: "a CalDAV/CardDAV 401 is always the account
 * level"), but it completes the pair the same way
 * `markConnectedAccountFacetNeedsReauth` completes
 * `markConnectedAccountNeedsReauth`.
 */
export async function reactivateConnectedAccountFacet(
  db: Db,
  connectedAccountId: string,
  kind: ConnectedAccountFacetRow["kind"],
): Promise<void> {
  await db
    .update(connectedAccountFacets)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      and(
        eq(connectedAccountFacets.connectedAccountId, connectedAccountId),
        eq(connectedAccountFacets.kind, kind),
      ),
    );
}
