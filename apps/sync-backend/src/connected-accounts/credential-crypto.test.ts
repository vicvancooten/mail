import { describe, expect, it } from "vitest";
import {
  deriveCredentialKey,
  facetOAuthAudience,
  mailOAuthAudience,
  reAuthenticateOAuthCredential,
  sealOAuthCredential,
  sealPasswordCredential,
  sealSecret,
  unsealOAuthAccessToken,
  unsealPasswordCredential,
  unsealSecret,
  widenOAuthCredential,
} from "./credential-crypto.js";

const key = deriveCredentialKey("some-instance-held-key-material");

describe("sealSecret / unsealSecret", () => {
  it("round-trips a secret under its associated data", () => {
    const sealed = sealSecret("hunter2", "connected-account-1", key);
    expect(unsealSecret(sealed, "connected-account-1", key)).toBe("hunter2");
  });

  it("never stores the plaintext anywhere in the sealed envelope", () => {
    const sealed = sealSecret("hunter2", "connected-account-1", key);
    expect(JSON.stringify(sealed)).not.toContain("hunter2");
  });

  it("refuses to unseal under the wrong associated data (ADR-0003: no cross-row transplant)", () => {
    const sealed = sealSecret("hunter2", "connected-account-1", key);
    expect(() => unsealSecret(sealed, "connected-account-2", key)).toThrow();
  });

  it("refuses to unseal under the wrong key", () => {
    const sealed = sealSecret("hunter2", "connected-account-1", key);
    const otherKey = deriveCredentialKey("a completely different key");
    expect(() => unsealSecret(sealed, "connected-account-1", otherKey)).toThrow();
  });

  it("refuses an unknown key version", () => {
    const sealed = sealSecret("hunter2", "connected-account-1", key);
    expect(() => unsealSecret({ ...sealed, keyVersion: 99 }, "connected-account-1", key)).toThrow();
  });
});

describe("sealPasswordCredential / unsealPasswordCredential", () => {
  it("round-trips a password credential", () => {
    const credential = sealPasswordCredential("swordfish", "connected-account-1", key);
    expect(credential.kind).toBe("password");
    expect(unsealPasswordCredential(credential, "connected-account-1", key)).toBe("swordfish");
  });

  it("refuses to unseal a non-password credential as a password", () => {
    const oauthCredential = sealOAuthCredential(
      {
        provider: "google",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: new Date().toISOString(),
        scope: ["https://mail.google.com/"],
      },
      "default",
      "connected-account-1",
      key,
    );
    expect(() => unsealPasswordCredential(oauthCredential, "connected-account-1", key)).toThrow();
  });
});

describe("mailOAuthAudience", () => {
  it("is Google's single 'default' audience", () => {
    expect(mailOAuthAudience("google")).toBe("default");
  });

  it("is Microsoft's 'imap' audience — Graph is a different one", () => {
    expect(mailOAuthAudience("microsoft")).toBe("imap");
  });
});

describe("sealOAuthCredential / unsealOAuthAccessToken", () => {
  it("round-trips the access token — the one XOAUTH2 needs — for the sealed audience", () => {
    const credential = sealOAuthCredential(
      {
        provider: "google",
        accessToken: "ya29.the-access-token",
        refreshToken: "1//the-refresh-token",
        expiresAt: "2026-01-01T00:00:00.000Z",
        scope: ["https://mail.google.com/"],
      },
      "default",
      "connected-account-1",
      key,
    );
    expect(credential.kind).toBe("oauth");
    expect(unsealOAuthAccessToken(credential, "default", "connected-account-1", key)).toBe(
      "ya29.the-access-token",
    );
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
      "imap",
      "connected-account-1",
      key,
    );
    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain("the-access-token");
    expect(serialized).not.toContain("the-refresh-token");
  });

  it("refuses to unseal a password credential as oauth", () => {
    const passwordCredential = sealPasswordCredential("swordfish", "connected-account-1", key);
    expect(() =>
      unsealOAuthAccessToken(passwordCredential, "default", "connected-account-1", key),
    ).toThrow();
  });

  it("throws for an audience that was never minted", () => {
    const credential = sealOAuthCredential(
      {
        provider: "microsoft",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: "2026-01-01T00:00:00.000Z",
        scope: ["https://outlook.office.com/IMAP.AccessAsUser.All"],
      },
      "imap",
      "connected-account-1",
      key,
    );
    expect(() => unsealOAuthAccessToken(credential, "graph", "connected-account-1", key)).toThrow();
  });
});

describe("reAuthenticateOAuthCredential", () => {
  it("refreshes one audience's access token and the refresh token, leaving other audiences untouched", () => {
    const original = sealOAuthCredential(
      {
        provider: "microsoft",
        accessToken: "old-imap-token",
        refreshToken: "old-refresh",
        expiresAt: "2026-01-01T00:00:00.000Z",
        scope: ["https://outlook.office.com/IMAP.AccessAsUser.All"],
      },
      "imap",
      "connected-account-1",
      key,
    );

    const refreshed = reAuthenticateOAuthCredential(
      original,
      {
        provider: "microsoft",
        accessToken: "new-imap-token",
        refreshToken: "new-refresh",
        expiresAt: "2026-01-01T01:00:00.000Z",
        scope: ["https://outlook.office.com/IMAP.AccessAsUser.All"],
      },
      "imap",
      "connected-account-1",
      key,
    );

    expect(unsealOAuthAccessToken(refreshed, "imap", "connected-account-1", key)).toBe(
      "new-imap-token",
    );
    if (refreshed.kind !== "oauth") throw new Error("expected oauth");
    expect(unsealSecret(refreshed.refreshToken, "connected-account-1", key)).toBe("new-refresh");
  });

  it("refuses to refresh a password credential", () => {
    const passwordCredential = sealPasswordCredential("swordfish", "connected-account-1", key);
    expect(() =>
      reAuthenticateOAuthCredential(
        passwordCredential,
        {
          provider: "google",
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: "2026-01-01T00:00:00.000Z",
          scope: [],
        },
        "default",
        "connected-account-1",
        key,
      ),
    ).toThrow();
  });
});

describe("facetOAuthAudience", () => {
  it("is Google's single 'default' audience regardless of Facet", () => {
    expect(facetOAuthAudience("google", "mail")).toBe("default");
    expect(facetOAuthAudience("google", "calendar")).toBe("default");
    expect(facetOAuthAudience("google", "contacts")).toBe("default");
  });

  it("splits Microsoft's Mail Facet onto 'imap' and Calendar/Contacts onto the shared 'graph' audience", () => {
    expect(facetOAuthAudience("microsoft", "mail")).toBe("imap");
    expect(facetOAuthAudience("microsoft", "calendar")).toBe("graph");
    expect(facetOAuthAudience("microsoft", "contacts")).toBe("graph");
  });
});

describe("widenOAuthCredential", () => {
  it("unions the new Facet's scope into what the credential already carried, rather than replacing it", () => {
    const original = sealOAuthCredential(
      {
        provider: "google",
        accessToken: "mail-access-token",
        refreshToken: "original-refresh",
        expiresAt: "2026-01-01T00:00:00.000Z",
        scope: ["https://mail.google.com/", "openid", "email"],
      },
      "default",
      "connected-account-1",
      key,
    );

    const widened = widenOAuthCredential(
      original,
      {
        provider: "google",
        accessToken: "calendar-access-token",
        refreshToken: "fresh-refresh",
        expiresAt: "2026-02-01T00:00:00.000Z",
        scope: ["https://www.googleapis.com/auth/calendar", "openid", "email"],
      },
      "default",
      "connected-account-1",
      key,
    );

    if (widened.kind !== "oauth") throw new Error("expected oauth");
    expect(widened.scope.sort()).toEqual(
      [
        "https://mail.google.com/",
        "https://www.googleapis.com/auth/calendar",
        "openid",
        "email",
      ].sort(),
    );
    expect(unsealSecret(widened.refreshToken, "connected-account-1", key)).toBe("fresh-refresh");
    expect(unsealOAuthAccessToken(widened, "default", "connected-account-1", key)).toBe(
      "calendar-access-token",
    );
  });

  it("adds the new audience's access token without disturbing another audience's — Mail keeps working (#202's own acceptance criterion)", () => {
    const original = sealOAuthCredential(
      {
        provider: "microsoft",
        accessToken: "imap-access-token",
        refreshToken: "shared-refresh",
        expiresAt: "2026-01-01T00:00:00.000Z",
        scope: ["https://outlook.office.com/IMAP.AccessAsUser.All", "offline_access"],
      },
      "imap",
      "connected-account-1",
      key,
    );

    const widened = widenOAuthCredential(
      original,
      {
        provider: "microsoft",
        accessToken: "graph-access-token",
        refreshToken: "shared-refresh",
        expiresAt: "2026-01-01T02:00:00.000Z",
        scope: ["https://graph.microsoft.com/Calendars.ReadWrite", "offline_access"],
      },
      "graph",
      "connected-account-1",
      key,
    );

    expect(unsealOAuthAccessToken(widened, "imap", "connected-account-1", key)).toBe(
      "imap-access-token",
    );
    expect(unsealOAuthAccessToken(widened, "graph", "connected-account-1", key)).toBe(
      "graph-access-token",
    );
  });

  it("refuses to widen a password credential", () => {
    const passwordCredential = sealPasswordCredential("swordfish", "connected-account-1", key);
    expect(() =>
      widenOAuthCredential(
        passwordCredential,
        {
          provider: "google",
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: "2026-01-01T00:00:00.000Z",
          scope: [],
        },
        "default",
        "connected-account-1",
        key,
      ),
    ).toThrow();
  });
});
