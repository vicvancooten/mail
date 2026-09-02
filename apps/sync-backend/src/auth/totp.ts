import { generateSecret, generateURI, verify } from "otplib";

/** Shown as the issuer in an authenticator app next to the username. */
const ISSUER = "Mail";

/** Base32 shared secret, otplib's default 20 random bytes. */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** The `otpauth://` URI an authenticator app scans (or accepts pasted) to enroll. */
export function totpAuthUri(username: string, secret: string): string {
  return generateURI({ issuer: ISSUER, label: username, secret });
}

export type TotpVerifyResult =
  | { valid: true /** The time step the code matched, for replay protection. */; timeStep: number }
  | { valid: false };

/**
 * Verifies a 6-digit code against `secret`, tolerating ±30s of clock drift
 * (one otplib time step either side). `afterTimeStep` — the caller's
 * `totp_credentials.lastUsedTimeStep` — rejects a code from a step already
 * spent, so an intercepted code can't be replayed inside its own window.
 */
export async function verifyTotpCode(
  secret: string,
  token: string,
  afterTimeStep?: number,
): Promise<TotpVerifyResult> {
  const result = await verify({ secret, token, epochTolerance: 30, afterTimeStep });
  if (!result.valid) {
    return { valid: false };
  }

  // otplib's top-level `verify()` return type covers both TOTP and HOTP
  // results, and only the former carries `timeStep` — this module never
  // asks for HOTP, so its absence would mean otplib changed behavior underneath us.
  if (!("timeStep" in result)) {
    throw new Error("otplib returned a non-TOTP result from a TOTP verification");
  }
  return { valid: true, timeStep: result.timeStep };
}
