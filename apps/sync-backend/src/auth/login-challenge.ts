import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { loginChallenges } from "../db/schema.js";

/** Generous enough to type a 6-digit code, tight enough to bound the exposure window. */
const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Minted once a `PrimaryAuthMethod` succeeds but a confirmed TOTP enrollment still gates login. */
export async function createLoginChallenge(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();

  await db.insert(loginChallenges).values({
    id: hashToken(token),
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + LOGIN_CHALLENGE_TTL_MS),
  });

  return token;
}

/**
 * Atomically consumes a login challenge the same way `consumeClaimToken`
 * does: valid, unexpired tokens are deleted on the same round trip they're
 * checked, so it can only ever be redeemed once.
 */
export async function consumeLoginChallenge(db: Db, token: string): Promise<string | null> {
  const id = hashToken(token);
  const now = new Date();

  const deleted = await db
    .delete(loginChallenges)
    .where(and(eq(loginChallenges.id, id), gt(loginChallenges.expiresAt, now)))
    .returning({ userId: loginChallenges.userId });

  return deleted[0]?.userId ?? null;
}
