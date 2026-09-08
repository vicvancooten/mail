import type { RegisteredProvider } from "@mail/shared";
import { and, count, eq } from "drizzle-orm";
import type { SealedSecret } from "../connected-accounts/credential-crypto.js";
import type { Db } from "../db/client.js";
import { connectedAccounts, providerRegistrations } from "../db/schema.js";

export type ProviderRegistrationRow = typeof providerRegistrations.$inferSelect;

export async function getProviderRegistration(
  db: Db,
  provider: RegisteredProvider,
): Promise<ProviderRegistrationRow | null> {
  const [row] = await db
    .select()
    .from(providerRegistrations)
    .where(eq(providerRegistrations.provider, provider))
    .limit(1);
  return row ?? null;
}

/**
 * Create-or-replace, keyed on the primary key itself (ADR-0021: "the Owner
 * ... pastes the client ID and secret into the Instance page", no restart,
 * no history of past registrations). `createdAt` is left untouched by the
 * conflict branch — a replace is still the same Registration, not a new one.
 */
export async function upsertProviderRegistration(
  db: Db,
  provider: RegisteredProvider,
  clientId: string,
  clientSecret: SealedSecret,
): Promise<ProviderRegistrationRow> {
  const [row] = await db
    .insert(providerRegistrations)
    .values({ provider, clientId, clientSecret })
    .onConflictDoUpdate({
      target: providerRegistrations.provider,
      set: { clientId, clientSecret, updatedAt: new Date() },
    })
    .returning();
  if (!row) {
    throw new Error("Upsert of Provider Registration returned no row.");
  }
  return row;
}

export async function deleteProviderRegistration(
  db: Db,
  provider: RegisteredProvider,
): Promise<void> {
  await db.delete(providerRegistrations).where(eq(providerRegistrations.provider, provider));
}

/**
 * Stamps the result of one Grant refresh attempt through this Provider
 * (#118) — `routes/instance.ts#buildProviderHealth` derives `working`/
 * `failing` from the two columns this writes. `lastRefreshAt` is set on
 * every attempt regardless of outcome; `error` is `null` on success (clearing
 * any prior failure, same convention as `mail-accounts/store.ts#setSyncStatus`'s
 * `lastSyncError`) and the Provider's own failure detail otherwise.
 *
 * Never called for a `withdrawn` result: that's one Connected Account's
 * Needs Reauth, not a fact about the Provider as a whole, and a single
 * revoked Grant shouldn't flip a whole Provider to Failing while every other
 * account on it keeps refreshing fine.
 */
export async function recordProviderRefreshOutcome(
  db: Db,
  provider: RegisteredProvider,
  error: string | null,
): Promise<void> {
  await db
    .update(providerRegistrations)
    .set({ lastRefreshAt: new Date(), lastRefreshError: error, updatedAt: new Date() })
    .where(eq(providerRegistrations.provider, provider));
}

/**
 * Every Connected Account at this Provider (#199, ADR-0022: the credential
 * and its Provider moved off `mail_accounts` onto `connected_accounts`) —
 * used both by the delete-preview count and by the delete transition's own
 * target set (ADR-0021). Counts Connected Accounts rather than Mail
 * Accounts directly; today the two are the same number (Mail is the only
 * Facet), which is exactly what makes `listMailAccountsForProvider` below
 * still answer "how many Mail Accounts will stop syncing" correctly.
 */
export async function countMailAccountsForProvider(
  db: Db,
  provider: RegisteredProvider,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.provider, provider));
  return row?.value ?? 0;
}

export async function countNeedsReauthMailAccountsForProvider(
  db: Db,
  provider: RegisteredProvider,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(connectedAccounts)
    .where(
      and(eq(connectedAccounts.provider, provider), eq(connectedAccounts.status, "needs_reauth")),
    );
  return row?.value ?? 0;
}
