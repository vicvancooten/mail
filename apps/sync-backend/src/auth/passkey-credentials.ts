import type { AuthenticatorTransportFuture, CredentialDeviceType } from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { passkeyCredentials } from "../db/schema.js";

export type PasskeyCredentialRow = typeof passkeyCredentials.$inferSelect;

export async function listPasskeysForUser(db: Db, userId: string): Promise<PasskeyCredentialRow[]> {
  return db.select().from(passkeyCredentials).where(eq(passkeyCredentials.userId, userId));
}

export async function getPasskeyById(db: Db, id: string): Promise<PasskeyCredentialRow | null> {
  const [row] = await db
    .select()
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.id, id))
    .limit(1);
  return row ?? null;
}

export interface NewPasskey {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  transports: AuthenticatorTransportFuture[] | null;
}

export async function insertPasskey(db: Db, passkey: NewPasskey): Promise<void> {
  await db.insert(passkeyCredentials).values(passkey);
}

/** Bumps the signature counter after a successful login — part of `@simplewebauthn`'s clone detection. */
export async function touchPasskeyCounter(db: Db, id: string, counter: number): Promise<void> {
  await db
    .update(passkeyCredentials)
    .set({ counter, lastUsedAt: new Date() })
    .where(eq(passkeyCredentials.id, id));
}

/** Scoped to `userId` so one User can never remove another's passkey by guessing an id. */
export async function deletePasskeyForUser(db: Db, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(passkeyCredentials)
    .where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.userId, userId)))
    .returning({ id: passkeyCredentials.id });
  return deleted.length > 0;
}
