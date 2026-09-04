import type { Provider } from "@mail/shared";
import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mailAccounts, providerRegistrations } from "../db/schema.js";
import type { SealedSecret } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";

export type ProviderRegistrationRow = typeof providerRegistrations.$inferSelect;

export async function getProviderRegistration(
  db: Db,
  provider: Provider,
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
  provider: Provider,
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

export async function deleteProviderRegistration(db: Db, provider: Provider): Promise<void> {
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
 * Never called for a `withdrawn` result: that's one Mail Account's Needs
 * Reauth, not a fact about the Provider as a whole, and a single revoked
 * Grant shouldn't flip a whole Provider to Failing while every other account
 * on it keeps refreshing fine.
 */
export async function recordProviderRefreshOutcome(
  db: Db,
  provider: Provider,
  error: string | null,
): Promise<void> {
  await db
    .update(providerRegistrations)
    .set({ lastRefreshAt: new Date(), lastRefreshError: error, updatedAt: new Date() })
    .where(eq(providerRegistrations.provider, provider));
}

/**
 * Every Mail Account whose `oauth` credential names this Provider
 * (`mail-accounts/credential-crypto.ts`'s tagged union) — there is no
 * `mail_accounts.provider` column, so this reads the value straight out of
 * the sealed-alongside `credential` jsonb rather than duplicating it onto a
 * new column. Used both by the delete-preview count and by the delete
 * transition's own target set (ADR-0021).
 */
function forProvider(provider: Provider) {
  return sql`${mailAccounts.credential}->>'provider' = ${provider}`;
}

export async function countMailAccountsForProvider(db: Db, provider: Provider): Promise<number> {
  const [row] = await db.select({ value: count() }).from(mailAccounts).where(forProvider(provider));
  return row?.value ?? 0;
}

export async function countNeedsReauthMailAccountsForProvider(
  db: Db,
  provider: Provider,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(mailAccounts)
    .where(and(forProvider(provider), eq(mailAccounts.status, "needs_reauth")));
  return row?.value ?? 0;
}

export async function listMailAccountsForProvider(
  db: Db,
  provider: Provider,
): Promise<MailAccountRow[]> {
  return db.select().from(mailAccounts).where(forProvider(provider));
}
