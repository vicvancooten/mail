import { describe, expect, it } from "vitest";
import {
  deriveCredentialKey,
  sealPasswordCredential,
  sealSecret,
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
