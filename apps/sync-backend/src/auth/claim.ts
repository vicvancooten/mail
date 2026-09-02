import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { claimTokens, users } from "../db/schema.js";

/** Generous window: the operator reads it from `docker compose logs`, not live. */
const CLAIM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * True once an Owner exists. First-run claiming is only possible before
 * that — there is no invite flow yet (poc-scope.md), so "unclaimed" and
 * "has zero users" are the same fact.
 */
export async function isClaimed(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return row !== undefined;
}

/**
 * Called once at boot (ADR-0009 deployment: "a one-time token printed to the
 * container logs"). Does nothing once the instance is claimed. Otherwise
 * invalidates whatever was printed on a previous boot and mints a fresh
 * token, so a stale token sitting in old logs can never claim the instance.
 */
export async function ensureClaimToken(
  db: Db,
  logger: FastifyBaseLogger,
  publicUrl: string,
): Promise<void> {
  if (await isClaimed(db)) {
    return;
  }

  await db.delete(claimTokens);

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.insert(claimTokens).values({
    id: hashToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLAIM_TOKEN_TTL_MS),
  });

  const claimUrl = new URL(`/claim?token=${token}`, publicUrl).toString();
  logger.info(
    { claimToken: token, claimUrl },
    `No Owner claimed yet. Claim this instance: ${claimUrl}`,
  );
}

/**
 * Atomically consumes a claim token: valid, unexpired tokens are deleted on
 * the same round trip they're checked, so two concurrent claims can never
 * both succeed. Returns whether the token was valid.
 */
export async function consumeClaimToken(db: Db, token: string): Promise<boolean> {
  const id = hashToken(token);
  const now = new Date();

  const deleted = await db
    .delete(claimTokens)
    .where(and(eq(claimTokens.id, id), gt(claimTokens.expiresAt, now)))
    .returning({ id: claimTokens.id });

  return deleted.length > 0;
}
