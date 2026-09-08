import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { RegisteredProvider } from "@mail/shared";

/**
 * The AEAD envelope for one sealed secret (ADR-0003): AES-256-GCM with a
 * fresh random IV per seal, the owning row's id as associated data so a
 * ciphertext can't be transplanted between rows, and `keyVersion` so a
 * future key rotation can tell which key unseals a given row. Everything
 * here is base64 — this is what actually sits in a `credential` jsonb
 * column, never the raw secret.
 */
export interface SealedSecret {
  keyVersion: number;
  iv: string;
  ciphertext: string;
  authTag: string;
}

/**
 * The two audiences an oauth Grant's access tokens are ever minted for
 * (ADR-0022): `default` is Google's one token good for every scope on the
 * Grant; Microsoft mints a separate access token per resource because IMAP
 * and Graph are different audiences to its identity platform — `imap` for
 * the Mail Facet, `graph` for Calendar/Contacts once those Facets exist.
 * Only `imap`/`default` is ever populated by this ticket (Mail is the only
 * Facet turned on so far); the map shape is what lets a later Facet add its
 * own audience without a credential migration.
 */
export type OAuthAudience = "default" | "imap" | "graph";

/**
 * The oauth audience one Facet's own access token is minted under, per
 * Provider (ADR-0022): Google mints one token good for every granted scope
 * regardless of which Facet asked, so every Facet shares `default`; Microsoft
 * mints IMAP's and Graph's access tokens separately, so Mail gets `imap` and
 * Calendar/Contacts (#202) share `graph` — the same Graph API answers both.
 */
export function facetOAuthAudience(
  provider: "google" | "microsoft",
  facet: "mail" | "calendar" | "contacts",
): OAuthAudience {
  if (provider === "google") return "default";
  return facet === "mail" ? "imap" : "graph";
}

/** The oauth audience the Mail Facet's own access token is minted under, per Provider (ADR-0022). */
export function mailOAuthAudience(provider: "google" | "microsoft"): OAuthAudience {
  return facetOAuthAudience(provider, "mail");
}

/**
 * The tagged union ADR-0003 committed to and ADR-0022 widens: `password`
 * covers Other IMAP and CalDAV/CardDAV alike; `oauth` is now **one refresh
 * token serving several audiences** rather than one Mail Account's own pair —
 * a scope set that grows as Facets turn on, and an access token minted and
 * refreshed per audience rather than one shared token. Turning on a second
 * Facet adds an entry to `accessTokens`, never a second credential.
 */
export type ConnectedAccountCredential =
  | { kind: "password"; secret: SealedSecret }
  | {
      kind: "oauth";
      provider: RegisteredProvider;
      refreshToken: SealedSecret;
      /** The union of every granted Facet's scopes so far (ADR-0022's "a growing scope set"). */
      scope: string[];
      accessTokens: Partial<Record<OAuthAudience, { token: SealedSecret; expiresAt: string }>>;
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
 * must be the owning row's id — a Connected Account's own id since ADR-0022
 * moved the credential up from the Mail Account — passing anything else
 * produces a ciphertext that `unsealSecret` will refuse to open once bound to
 * the real row, which is the point (ADR-0003: "a ciphertext cannot be
 * transplanted between rows").
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

/** Seals a `password` credential — Other IMAP and CalDAV/CardDAV's only variant. */
export function sealPasswordCredential(
  password: string,
  connectedAccountId: string,
  key: Buffer,
): ConnectedAccountCredential {
  return { kind: "password", secret: sealSecret(password, connectedAccountId, key) };
}

/** Unseals a `password` credential's secret back to the plaintext IMAP/SMTP password (or CalDAV/CardDAV app password). */
export function unsealPasswordCredential(
  credential: ConnectedAccountCredential,
  connectedAccountId: string,
  key: Buffer,
): string {
  if (credential.kind !== "password") {
    throw new Error(`Cannot unseal a "${credential.kind}" credential as a password.`);
  }
  return unsealSecret(credential.secret, connectedAccountId, key);
}

/** The plaintext a Grant carries — what a sign-in flow (#116/#117) hands this module to seal, for one audience. */
export interface OAuthTokens {
  provider: RegisteredProvider;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string[];
}

/**
 * Seals a brand-new `oauth` credential — the Grant, per ADR-0021/ADR-0022 —
 * with its first audience's access token. Turning on a further Facet widens
 * an *existing* credential instead (`widenOAuthCredential` below), never
 * calling this again.
 */
export function sealOAuthCredential(
  tokens: OAuthTokens,
  audience: OAuthAudience,
  connectedAccountId: string,
  key: Buffer,
): ConnectedAccountCredential {
  return {
    kind: "oauth",
    provider: tokens.provider,
    refreshToken: sealSecret(tokens.refreshToken, connectedAccountId, key),
    scope: tokens.scope,
    accessTokens: {
      [audience]: {
        token: sealSecret(tokens.accessToken, connectedAccountId, key),
        expiresAt: tokens.expiresAt,
      },
    },
  };
}

/**
 * A Grant refresh's write path (#118, ADR-0022): reseals the refresh token
 * (Providers may or may not rotate it) and this one audience's access token,
 * leaving every other audience's access token untouched — "a Grant refresh
 * refreshes one audience and leaves the others alone".
 */
export function reAuthenticateOAuthCredential(
  existing: ConnectedAccountCredential,
  tokens: OAuthTokens,
  audience: OAuthAudience,
  connectedAccountId: string,
  key: Buffer,
): ConnectedAccountCredential {
  if (existing.kind !== "oauth") {
    throw new Error(`Cannot refresh a "${existing.kind}" credential as oauth.`);
  }
  return {
    kind: "oauth",
    provider: tokens.provider,
    refreshToken: sealSecret(tokens.refreshToken, connectedAccountId, key),
    scope: tokens.scope,
    accessTokens: {
      ...existing.accessTokens,
      [audience]: {
        token: sealSecret(tokens.accessToken, connectedAccountId, key),
        expiresAt: tokens.expiresAt,
      },
    },
  };
}

/**
 * Turning on a further Facet's write path (#202, ADR-0022): widens an
 * *existing* oauth credential rather than replacing it. Unlike
 * `reAuthenticateOAuthCredential` above, `scope` is a **union** with what the
 * credential already carried, never a replacement — ADR-0022's "the union of
 * every granted Facet's scopes so far" — since the consent round this seals
 * only ever asked for the new Facet's own scope (`include_granted_scopes` is
 * what keeps Google's previously granted scopes true on the Provider's side;
 * this is what keeps them true in what's stored). The refresh token is
 * resealed with whatever `exchangeCode` returned, the same as a reauth —
 * every facet-grant exchange requests `offline_access`/`prompt=consent`
 * precisely so one always comes back. This one audience's access token is
 * added, never replacing another audience's, the same "leaves the others
 * alone" rule `reAuthenticateOAuthCredential` already follows.
 */
export function widenOAuthCredential(
  existing: ConnectedAccountCredential,
  tokens: OAuthTokens,
  audience: OAuthAudience,
  connectedAccountId: string,
  key: Buffer,
): ConnectedAccountCredential {
  if (existing.kind !== "oauth") {
    throw new Error(`Cannot widen a "${existing.kind}" credential as oauth.`);
  }
  return {
    kind: "oauth",
    provider: tokens.provider,
    refreshToken: sealSecret(tokens.refreshToken, connectedAccountId, key),
    scope: Array.from(new Set([...existing.scope, ...tokens.scope])),
    accessTokens: {
      ...existing.accessTokens,
      [audience]: {
        token: sealSecret(tokens.accessToken, connectedAccountId, key),
        expiresAt: tokens.expiresAt,
      },
    },
  };
}

/**
 * Unseals one audience's access token — the one XOAUTH2 needs to
 * authenticate for that audience. Throws when the credential has never had
 * that audience's token minted (a Facet that was never turned on).
 */
export function unsealOAuthAccessToken(
  credential: ConnectedAccountCredential,
  audience: OAuthAudience,
  connectedAccountId: string,
  key: Buffer,
): string {
  if (credential.kind !== "oauth") {
    throw new Error(`Cannot unseal a "${credential.kind}" credential as oauth.`);
  }
  const entry = credential.accessTokens[audience];
  if (!entry) {
    throw new Error(`This oauth credential has no access token minted for audience "${audience}".`);
  }
  return unsealSecret(entry.token, connectedAccountId, key);
}
