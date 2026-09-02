import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import type { UserRow } from "./auth-method.js";

/** ~60-day sliding expiry, per poc-spec.md §Auth & Users. */
export const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * How stale `lastSeenAt` must be before an authenticated request bothers
 * sliding the expiry forward. Without this, every request would write to
 * `sessions` — the cookie's `Max-Age` is refreshed on the same cadence so
 * the two never disagree by more than this window.
 */
const RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions are looked up by this hash; the raw token is never stored. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
  });

  return { token, expiresAt };
}

export interface ValidatedSession {
  user: UserRow;
  /** Set when the sliding window was just pushed forward — re-set the cookie. */
  renewed: boolean;
  expiresAt: Date;
}

/**
 * Looks up a session by its raw cookie token, sliding the expiry forward
 * when it's been more than `RENEWAL_INTERVAL_MS` since it was last touched.
 * Returns `null` for a missing, expired, or otherwise invalid token —
 * callers don't get to distinguish which, matching an opaque session.
 */
export async function validateSession(db: Db, token: string): Promise<ValidatedSession | null> {
  const id = hashToken(token);
  const now = new Date();

  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)))
    .limit(1);

  if (!row) {
    return null;
  }

  const staleSince = now.getTime() - row.session.lastSeenAt.getTime();
  if (staleSince < RENEWAL_INTERVAL_MS) {
    return { user: row.user, renewed: false, expiresAt: row.session.expiresAt };
  }

  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.update(sessions).set({ expiresAt, lastSeenAt: now }).where(eq(sessions.id, id));

  return { user: row.user, renewed: true, expiresAt };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Used by the operator CLI's password-reset escape hatch: force re-login everywhere. */
export async function revokeAllSessionsForUser(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
