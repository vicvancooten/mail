import type { Db } from "../db/client.js";
import type { UserRow } from "./auth-method.js";
import { createLoginChallenge } from "./login-challenge.js";
import { createSession } from "./sessions.js";
import { getConfirmedTotpCredential } from "./totp-credentials.js";

export type LoginOutcome =
  | { kind: "session"; token: string; expiresAt: Date }
  | { kind: "totp_required"; challengeToken: string };

/**
 * What every `PrimaryAuthMethod` funnels into once it accepts a User: a
 * session immediately, or — when a confirmed TOTP enrollment exists — a
 * login challenge instead. Shared by `/auth/login` and
 * `/auth/passkeys/login/verify` so TOTP gates both primaries identically
 * without either route reimplementing the check (#32).
 */
export async function completeLogin(db: Db, user: UserRow): Promise<LoginOutcome> {
  const totp = await getConfirmedTotpCredential(db, user.id);
  if (!totp) {
    const { token, expiresAt } = await createSession(db, user.id);
    return { kind: "session", token, expiresAt };
  }

  const challengeToken = await createLoginChallenge(db, user.id);
  return { kind: "totp_required", challengeToken };
}
