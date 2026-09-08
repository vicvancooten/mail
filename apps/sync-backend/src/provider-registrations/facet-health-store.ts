import type { ConnectedAccountFacetKind, RegisteredProvider } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connectedAccountFacets, connectedAccounts, providerFacetHealth } from "../db/schema.js";

export type ProviderFacetHealthRow = typeof providerFacetHealth.$inferSelect;

function facetHealthId(provider: RegisteredProvider, facet: ConnectedAccountFacetKind): string {
  return `${provider}-${facet}`;
}

/** Every (Facet) row recorded for one Provider, keyed by Facet — `routes/instance.ts#buildProviderHealth`'s own per-Facet source, one row missing entirely for a Facet that's never been granted or refreshed. */
export async function getProviderFacetHealth(
  db: Db,
  provider: RegisteredProvider,
): Promise<Map<ConnectedAccountFacetKind, ProviderFacetHealthRow>> {
  const rows = await db
    .select()
    .from(providerFacetHealth)
    .where(eq(providerFacetHealth.provider, provider));
  return new Map(rows.map((row) => [row.facet as ConnectedAccountFacetKind, row]));
}

/**
 * Stamps the first time a Facet is ever granted at a Provider
 * (`routes/oauth-signin.ts`'s `signed_in` and `facet_added` outcomes) —
 * read-then-write rather than a single upsert, so `firstGrantedAt` is set
 * only if it isn't already: a second Connected Account granting the same
 * Facet again never moves the timestamp forward.
 */
export async function recordFacetFirstGrant(
  db: Db,
  provider: RegisteredProvider,
  facet: ConnectedAccountFacetKind,
): Promise<void> {
  const id = facetHealthId(provider, facet);
  const now = new Date();
  const [existing] = await db
    .select({ firstGrantedAt: providerFacetHealth.firstGrantedAt })
    .from(providerFacetHealth)
    .where(eq(providerFacetHealth.id, id))
    .limit(1);
  if (existing) {
    if (existing.firstGrantedAt) return;
    await db
      .update(providerFacetHealth)
      .set({ firstGrantedAt: now, updatedAt: now })
      .where(eq(providerFacetHealth.id, id));
    return;
  }
  await db.insert(providerFacetHealth).values({ id, provider, facet, firstGrantedAt: now });
}

/**
 * Stamps the result of one refresh attempt through this Facet at this
 * Provider, the per-Facet twin of `provider-registrations/store.ts#recordProviderRefreshOutcome`
 * — `lastRefreshAt` on every attempt, `lastRefreshError` cleared on success
 * and set otherwise. `apiNotEnabled` defaults `false` (cleared) and is set
 * `true` only by a caller that actually saw a 403-not-enabled response; no
 * caller does yet (#205's own doc comment on `db/schema.ts#providerFacetHealth`).
 */
export async function recordFacetRefreshOutcome(
  db: Db,
  provider: RegisteredProvider,
  facet: ConnectedAccountFacetKind,
  outcome: { error: string | null; apiNotEnabled?: boolean },
): Promise<void> {
  const id = facetHealthId(provider, facet);
  const now = new Date();
  const apiNotEnabled = outcome.apiNotEnabled ?? false;
  await db
    .insert(providerFacetHealth)
    .values({
      id,
      provider,
      facet,
      lastRefreshAt: now,
      lastRefreshError: outcome.error,
      apiNotEnabled,
    })
    .onConflictDoUpdate({
      target: providerFacetHealth.id,
      set: {
        lastRefreshAt: now,
        lastRefreshError: outcome.error,
        apiNotEnabled,
        updatedAt: now,
      },
    });
}

/**
 * Every Connected Account carrying a given Facet at a given Provider, split
 * `active`/`needs_reauth` (#205's own "how many Connected Accounts, how many
 * parked" per Facet) — the join `provider-registrations/store.ts#countMailAccountsForProvider`
 * never needed, since that one only ever counted the whole Connected
 * Account, not a single Facet on it.
 */
export async function countConnectedAccountsForProviderFacet(
  db: Db,
  provider: RegisteredProvider,
  facet: ConnectedAccountFacetKind,
): Promise<{ connectedAccountCount: number; parkedCount: number }> {
  const rows = await db
    .select({ status: connectedAccountFacets.status })
    .from(connectedAccountFacets)
    .innerJoin(
      connectedAccounts,
      eq(connectedAccounts.id, connectedAccountFacets.connectedAccountId),
    )
    .where(and(eq(connectedAccounts.provider, provider), eq(connectedAccountFacets.kind, facet)));
  const connectedAccountCount = rows.length;
  const parkedCount = rows.filter((row) => row.status === "needs_reauth").length;
  return { connectedAccountCount, parkedCount };
}
