import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { totpCredentials } from "../db/schema.js";

export type TotpCredentialRow = typeof totpCredentials.$inferSelect;

/** The row a login checks against — an unconfirmed enrollment never gates login. */
export async function getConfirmedTotpCredential(
  db: Db,
  userId: string,
): Promise<TotpCredentialRow | null> {
  const [row] = await db
    .select()
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .limit(1);
  return row?.confirmed ? row : null;
}

export async function getTotpCredential(db: Db, userId: string): Promise<TotpCredentialRow | null> {
  const [row] = await db
    .select()
    .from(totpCredentials)
    .where(eq(totpCredentials.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Starts (or restarts) enrollment: upserts a fresh, unconfirmed secret.
 * Callers must reject this when a confirmed row already exists — silently
 * replacing a live secret would let a hijacked session strip 2FA without
 * ever proving the current code.
 */
export async function startTotpEnrollment(db: Db, userId: string, secret: string): Promise<void> {
  await db
    .insert(totpCredentials)
    .values({ userId, secret, confirmed: false, lastUsedTimeStep: null })
    .onConflictDoUpdate({
      target: totpCredentials.userId,
      set: { secret, confirmed: false, lastUsedTimeStep: null },
    });
}

export async function confirmTotpEnrollment(
  db: Db,
  userId: string,
  timeStep: number,
): Promise<void> {
  await db
    .update(totpCredentials)
    .set({ confirmed: true, lastUsedTimeStep: timeStep })
    .where(eq(totpCredentials.userId, userId));
}

export async function recordTotpUse(db: Db, userId: string, timeStep: number): Promise<void> {
  await db
    .update(totpCredentials)
    .set({ lastUsedTimeStep: timeStep })
    .where(eq(totpCredentials.userId, userId));
}

export async function deleteTotpCredential(db: Db, userId: string): Promise<void> {
  await db.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
}
