import type { AuthMethodType, User } from "@mail/shared";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { getPasskeyById, touchPasskeyCounter } from "./passkey-credentials.js";
import { verifyPassword } from "./password.js";

/**
 * A primary way a User can authenticate, e.g. at the login screen. Password
 * and passkeys (#32) are the two implementations; passkeys are looked up by
 * credential id instead of username. This is the `AuthMethod` seam every
 * later ticket bolts onto — the login route and session issuance never need
 * to reshape when a new method lands, only `authMethods` grows a key.
 *
 * `Credentials` varies per method (a username+password pair vs. a WebAuthn
 * assertion) — the seam is the shared shape of "check these, hand back a
 * user row or nothing," not a single wire format every method must speak.
 *
 * TOTP is deliberately not a `PrimaryAuthMethod`: it is a second factor
 * checked *after* one of these succeeds (`src/auth/login-flow.ts`), not an
 * alternative to them.
 */
export interface PrimaryAuthMethod<Credentials = never> {
  readonly type: AuthMethodType;
  /** Resolves to the authenticated user's row, or `null` on any failure. */
  authenticate(db: Db, credentials: Credentials): Promise<UserRow | null>;
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

export interface PasswordCredentials {
  username: string;
  password: string;
}

export const passwordAuthMethod: PrimaryAuthMethod<PasswordCredentials> = {
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

export interface PasskeyCredentials {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  /** Derived from `PUBLIC_URL` by the caller (`src/auth/webauthn.ts`) — this seam stays free of it. */
  expectedOrigin: string;
  expectedRPID: string;
}

export const passkeyAuthMethod: PrimaryAuthMethod<PasskeyCredentials> = {
  type: "passkey",
  async authenticate(db, { response, expectedChallenge, expectedOrigin, expectedRPID }) {
    const passkey = await getPasskeyById(db, response.id);
    if (!passkey) {
      return null;
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin,
        expectedRPID,
        credential: {
          id: passkey.id,
          publicKey: isoBase64URL.toBuffer(passkey.publicKey),
          counter: passkey.counter,
          // Stored verbatim from the AuthenticatorTransportFuture[] a prior
          // registration wrote (`insertPasskey`); the column is untyped text[].
          transports: (passkey.transports ?? undefined) as
            | AuthenticatorTransportFuture[]
            | undefined,
        },
      });
    } catch {
      return null;
    }
    if (!verification.verified) {
      return null;
    }

    await touchPasskeyCounter(db, passkey.id, verification.authenticationInfo.newCounter);

    const [row] = await db.select().from(users).where(eq(users.id, passkey.userId)).limit(1);
    return row ?? null;
  },
};

export const authMethods = {
  password: passwordAuthMethod,
  passkey: passkeyAuthMethod,
} satisfies Partial<Record<AuthMethodType, PrimaryAuthMethod<never>>>;
