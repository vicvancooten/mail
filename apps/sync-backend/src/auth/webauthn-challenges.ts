import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { webauthnChallenges } from "../db/schema.js";
import { isSecureOrigin } from "./cookies.js";

/** Long enough to scan a QR / tap a passkey prompt, short enough to bound replay exposure. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const CHALLENGE_COOKIE = "mail_webauthn_challenge";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Stashes a WebAuthn ceremony's server-generated challenge server-side and
 * returns the opaque bearer token for it — round-tripped through
 * `CHALLENGE_COOKIE` rather than a request-body field, so the Client never
 * threads it through by hand between the options and verify calls.
 * `userId` binds a registration to the already-authenticated User; `null`
 * for a login challenge, which is usernameless (the credential id in the
 * response resolves the User instead).
 */
export async function stashChallenge(
  db: Db,
  challenge: string,
  userId: string | null,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();

  await db.insert(webauthnChallenges).values({
    id: hashToken(token),
    challenge,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });

  return token;
}

export interface PendingChallenge {
  challenge: string;
  userId: string | null;
}

/** Atomically consumes a stashed challenge — single-use, like a claim or login token. */
export async function popChallenge(db: Db, token: string): Promise<PendingChallenge | null> {
  const id = hashToken(token);
  const now = new Date();

  const deleted = await db
    .delete(webauthnChallenges)
    .where(and(eq(webauthnChallenges.id, id), gt(webauthnChallenges.expiresAt, now)))
    .returning({ challenge: webauthnChallenges.challenge, userId: webauthnChallenges.userId });

  return deleted[0] ?? null;
}

export function setChallengeCookie(reply: FastifyReply, publicUrl: string, token: string) {
  reply.setCookie(CHALLENGE_COOKIE, token, {
    httpOnly: true,
    secure: isSecureOrigin(publicUrl),
    sameSite: "lax",
    path: "/",
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
}

export function clearChallengeCookie(reply: FastifyReply, publicUrl: string) {
  reply.clearCookie(CHALLENGE_COOKIE, {
    httpOnly: true,
    secure: isSecureOrigin(publicUrl),
    sameSite: "lax",
    path: "/",
  });
}

export function readChallengeCookie(request: FastifyRequest): string | undefined {
  return request.cookies[CHALLENGE_COOKIE];
}
