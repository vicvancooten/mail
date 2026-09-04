import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * The AEAD envelope for one sealed secret (ADR-0003): AES-256-GCM with a
 * fresh random IV per seal, the Mail Account id as associated data so a
 * ciphertext can't be transplanted between rows, and `keyVersion` so a
 * future key rotation can tell which key unseals a given row. Everything
 * here is base64 — this is what actually sits in the `credential` jsonb
 * column, never the raw secret.
 */
export interface SealedSecret {
  keyVersion: number;
  iv: string;
  ciphertext: string;
  authTag: string;
}

/**
 * The tagged union ADR-0003 commits to: `password` is the only variant
 * populated at PoC, `oauth` is sketched per docs/research/0004 §6 so it
 * slots in later as a new variant rather than a schema migration. Nothing
 * in this ticket writes an `oauth` row; the shape exists so `oauth`'s
 * eventual seam (access/refresh tokens, provider, scope) doesn't force a
 * rewrite of `password`'s storage.
 */
export type MailAccountCredential =
  | { kind: "password"; secret: SealedSecret }
  | {
      kind: "oauth";
      provider: "google" | "microsoft";
      accessToken: SealedSecret;
      refreshToken: SealedSecret;
      expiresAt: string;
      scope: string[];
    };

/** The only key version this build knows how to seal with or unseal. */
export const CURRENT_KEY_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * `MAIL_CREDENTIAL_KEY` (env.ts) is an operator-supplied string of unknown
 * length/encoding, not necessarily 32 raw bytes — hashing it down to a
 * fixed-size key is the normalization step, not an attempt at extra
 * security. The instance-held key itself is ADR-0003's whole threat model:
 * the database alone is useless, the database plus this key is not.
 */
export function deriveCredentialKey(mailCredentialKey: string): Buffer {
  return createHash("sha256").update(mailCredentialKey, "utf8").digest();
}

/**
 * Seals one secret (e.g. an IMAP/SMTP password) for storage. `associatedData`
 * must be the owning Mail Account's id — passing anything else produces a
 * ciphertext that `unsealSecret` will refuse to open once bound to the real
 * row, which is the point (ADR-0003: "a ciphertext cannot be transplanted
 * between rows").
 */
export function sealSecret(plaintext: string, associatedData: string, key: Buffer): SealedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyVersion: CURRENT_KEY_VERSION,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Unseals a secret sealed by `sealSecret`. Throws (rather than returning
 * `null`) on a wrong `associatedData`, a bit-flipped ciphertext, or an
 * unknown `keyVersion` — all three are corruption/tampering, not an
 * expected "credential missing" case a caller should branch on silently.
 */
export function unsealSecret(sealed: SealedSecret, associatedData: string, key: Buffer): string {
  if (sealed.keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(
      `Cannot unseal a credential sealed under key version ${sealed.keyVersion}; only ${CURRENT_KEY_VERSION} is loaded.`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Seals a `password` credential — the only variant this ticket writes. */
export function sealPasswordCredential(
  password: string,
  mailAccountId: string,
  key: Buffer,
): MailAccountCredential {
  return { kind: "password", secret: sealSecret(password, mailAccountId, key) };
}

/** Unseals a `password` credential's secret back to the plaintext IMAP/SMTP password. */
export function unsealPasswordCredential(
  credential: MailAccountCredential,
  mailAccountId: string,
  key: Buffer,
): string {
  if (credential.kind !== "password") {
    throw new Error(`Cannot unseal a "${credential.kind}" credential as a password.`);
  }
  return unsealSecret(credential.secret, mailAccountId, key);
}

/** The plaintext a Grant carries — what a sign-in flow (#116/#117) hands this module to seal. */
export interface OAuthTokens {
  provider: "google" | "microsoft";
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string[];
}

/** Seals an `oauth` credential's access and refresh tokens — the Grant, per ADR-0021. */
export function sealOAuthCredential(
  tokens: OAuthTokens,
  mailAccountId: string,
  key: Buffer,
): MailAccountCredential {
  return {
    kind: "oauth",
    provider: tokens.provider,
    accessToken: sealSecret(tokens.accessToken, mailAccountId, key),
    refreshToken: sealSecret(tokens.refreshToken, mailAccountId, key),
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
  };
}

/**
 * Unseals an `oauth` credential's access token — the one XOAUTH2 needs to
 * authenticate. Refresh (#118) is the only other consumer of the sibling
 * `refreshToken` field; nothing here reads it.
 */
export function unsealOAuthAccessToken(
  credential: MailAccountCredential,
  mailAccountId: string,
  key: Buffer,
): string {
  if (credential.kind !== "oauth") {
    throw new Error(`Cannot unseal a "${credential.kind}" credential as oauth.`);
  }
  return unsealSecret(credential.accessToken, mailAccountId, key);
}
