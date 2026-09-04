import { describe, expect, it } from "vitest";
import {
  deriveCredentialKey,
  sealOAuthCredential,
  sealPasswordCredential,
  sealSecret,
  unsealOAuthAccessToken,
  unsealPasswordCredential,
  unsealSecret,
} from "./credential-crypto.js";

const key = deriveCredentialKey("some-instance-held-key-material");

describe("sealSecret / unsealSecret", () => {
  it("round-trips a secret under its associated data", () => {
    const sealed = sealSecret("hunter2", "mail-account-1", key);
    expect(unsealSecret(sealed, "mail-account-1", key)).toBe("hunter2");
  });

  it("never stores the plaintext anywhere in the sealed envelope", () => {
    const sealed = sealSecret("hunter2", "mail-account-1", key);
    expect(JSON.stringify(sealed)).not.toContain("hunter2");
  });

  it("refuses to unseal under the wrong associated data (ADR-0003: no cross-row transplant)", () => {
    const sealed = sealSecret("hunter2", "mail-account-1", key);
    expect(() => unsealSecret(sealed, "mail-account-2", key)).toThrow();
  });

  it("refuses to unseal under the wrong key", () => {
    const sealed = sealSecret("hunter2", "mail-account-1", key);
    const otherKey = deriveCredentialKey("a completely different key");
    expect(() => unsealSecret(sealed, "mail-account-1", otherKey)).toThrow();
  });

  it("refuses an unknown key version", () => {
    const sealed = sealSecret("hunter2", "mail-account-1", key);
    expect(() => unsealSecret({ ...sealed, keyVersion: 99 }, "mail-account-1", key)).toThrow();
  });
});

describe("sealPasswordCredential / unsealPasswordCredential", () => {
  it("round-trips a password credential", () => {
    const credential = sealPasswordCredential("swordfish", "mail-account-1", key);
    expect(credential.kind).toBe("password");
    expect(unsealPasswordCredential(credential, "mail-account-1", key)).toBe("swordfish");
  });

  it("refuses to unseal a non-password credential as a password", () => {
    const oauthCredential = {
      kind: "oauth" as const,
      provider: "google" as const,
      accessToken: sealSecret("at", "mail-account-1", key),
      refreshToken: sealSecret("rt", "mail-account-1", key),
      expiresAt: new Date().toISOString(),
      scope: ["https://mail.google.com/"],
    };
    expect(() => unsealPasswordCredential(oauthCredential, "mail-account-1", key)).toThrow();
  });
});

describe("sealOAuthCredential / unsealOAuthAccessToken", () => {
  it("round-trips the access token — the one XOAUTH2 needs", () => {
    const credential = sealOAuthCredential(
      {
        provider: "google",
        accessToken: "ya29.the-access-token",
        refreshToken: "1//the-refresh-token",
        expiresAt: "2026-01-01T00:00:00.000Z",
        scope: ["https://mail.google.com/"],
      },
      "mail-account-1",
      key,
    );
    expect(credential.kind).toBe("oauth");
    expect(unsealOAuthAccessToken(credential, "mail-account-1", key)).toBe("ya29.the-access-token");
  });

  it("never stores either token plaintext in the sealed envelope", () => {
    const credential = sealOAuthCredential(
      {
        provider: "microsoft",
        accessToken: "the-access-token",
        refreshToken: "the-refresh-token",
        expiresAt: "2026-01-01T00:00:00.000Z",
        scope: ["offline_access"],
      },
      "mail-account-1",
      key,
    );
    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain("the-access-token");
    expect(serialized).not.toContain("the-refresh-token");
  });

  it("refuses to unseal a password credential as oauth", () => {
    const passwordCredential = sealPasswordCredential("swordfish", "mail-account-1", key);
    expect(() => unsealOAuthAccessToken(passwordCredential, "mail-account-1", key)).toThrow();
  });
});
