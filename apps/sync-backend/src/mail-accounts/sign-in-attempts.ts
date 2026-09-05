import { createHash, randomBytes } from "node:crypto";
import type { Provider } from "@mail/shared";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type OAuthSignInAttemptRow, oauthSignInAttempts } from "../db/schema.js";

/**
 * The short-lived state one "Sign in with Google" needs to survive the
 * full-page round trip (#116): started by `POST /auth/oauth/:provider/start`,
 * consumed once by the callback. Everything about single-use-ness lives here
 * — `consumeSignInAttempt` deletes as it reads, so a replayed callback is
 * indistinguishable from a forged one and both fail the same way.
 */

/** Long enough for a User to pick an account and read a consent screen, short enough that an abandoned attempt is not a lingering credential. */
const ATTEMPT_TTL_MS = 15 * 60 * 1000;

export type SignInPurpose = "add_mail_account" | "reauth";

export interface StartedSignInAttempt {
  /** Goes in the authorization URL and comes back in the callback; never stored as-is. */
  state: string;
  /** PKCE's secret, held server-side until the code exchange. */
  codeVerifier: string;
  /** What the Provider sees: the S256 hash of the verifier. */
  codeChallenge: string;
}

/** The bearer-token convention `sessions`/`claim_tokens` already use: the table holds the hash, the URL holds the value. */
function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** RFC 7636's S256: base64url of the SHA-256 of the verifier, no padding — which is what `base64url` already gives. */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export async function startSignInAttempt(
  db: Db,
  input: {
    userId: string;
    provider: Provider;
    purpose: SignInPurpose;
    /** Required (and only meaningful) for `purpose: "reauth"`. */
    mailAccountId?: string;
  },
  now: Date = new Date(),
): Promise<StartedSignInAttempt> {
  // Sweeps abandoned attempts on the way in: a User who closes the tab at
  // the consent screen leaves a row nothing else would ever delete, and
  // starting a new sign-in is the only moment this table is written at all.
  await deleteExpiredSignInAttempts(db, now);

  const state = randomBytes(32).toString("base64url");
  // 43 base64url characters from 32 random bytes — inside RFC 7636's 43..128
  // range without needing to trim or pad.
  const codeVerifier = randomBytes(32).toString("base64url");

  await db.insert(oauthSignInAttempts).values({
    id: hashState(state),
    userId: input.userId,
    provider: input.provider,
    codeVerifier,
    purpose: input.purpose,
    mailAccountId: input.mailAccountId ?? null,
    expiresAt: new Date(now.getTime() + ATTEMPT_TTL_MS),
  });

  return { state, codeVerifier, codeChallenge: deriveCodeChallenge(codeVerifier) };
}

/**
 * Redeems a callback's `state`, deleting the row in the same statement so it
 * can never be redeemed twice. Answers `null` for anything that isn't a live
 * attempt this User started for this Provider — unknown, replayed, expired,
 * or another User's — which the callback reports as one undifferentiated
 * `invalid_state`: telling a caller *which* of those it was tells an
 * attacker something and a User nothing.
 */
export async function consumeSignInAttempt(
  db: Db,
  input: { state: string; userId: string; provider: Provider },
  now: Date = new Date(),
): Promise<OAuthSignInAttemptRow | null> {
  const [row] = await db
    .delete(oauthSignInAttempts)
    .where(
      and(
        eq(oauthSignInAttempts.id, hashState(input.state)),
        eq(oauthSignInAttempts.userId, input.userId),
        eq(oauthSignInAttempts.provider, input.provider),
      ),
    )
    .returning();
  if (!row || row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return row;
}

/** Every attempt whose window has closed. Called by `startSignInAttempt` itself, so the table stays bounded without a scheduler. */
export async function deleteExpiredSignInAttempts(db: Db, now: Date = new Date()): Promise<void> {
  await db.delete(oauthSignInAttempts).where(lt(oauthSignInAttempts.expiresAt, now));
}
