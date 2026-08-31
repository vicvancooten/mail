import type { AuthMethodType, User } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyPassword } from "./password.js";

/**
 * A primary way a User can authenticate, e.g. at the login screen. Password
 * is the only implementation at PoC; passkeys (#32) add a second, looked up
 * by credential id instead of username. This is the `AuthMethod` seam every
 * later ticket bolts onto — the login route and session issuance never need
 * to reshape when a new method lands, only `authMethods` grows a key.
 *
 * TOTP is deliberately not a `PrimaryAuthMethod`: it is a second factor
 * checked *after* one of these succeeds, not an alternative to them.
 */
export interface PrimaryAuthMethod {
  readonly type: AuthMethodType;
  /** Resolves to the authenticated user's row, or `null` on any failure. */
  authenticate(
    db: Db,
    credentials: { username: string; password: string },
  ): Promise<UserRow | null>;
}

export type UserRow = typeof users.$inferSelect;

export function toWireUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

export const passwordAuthMethod: PrimaryAuthMethod = {
  type: "password",
  async authenticate(db, { username, password }) {
    const [row] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!row) {
      return null;
    }
    const valid = await verifyPassword(row.passwordHash, password);
    return valid ? row : null;
  },
};

export const authMethods: Partial<Record<AuthMethodType, PrimaryAuthMethod>> = {
  password: passwordAuthMethod,
};
