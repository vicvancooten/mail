import { describe, expect, it } from "vitest";
import { toImapAuth, toSmtpAuth, unsealMailAccountSecret } from "./credential-auth.js";
import {
  deriveCredentialKey,
  sealOAuthCredential,
  sealPasswordCredential,
} from "./credential-crypto.js";

const key = deriveCredentialKey("some-instance-held-key-material");

describe("unsealMailAccountSecret", () => {
  it("unseals a password credential to a password secret", () => {
    const credential = sealPasswordCredential("swordfish", "mail-account-1", key);
    expect(unsealMailAccountSecret(credential, "mail-account-1", key)).toEqual({
      kind: "password",
      password: "swordfish",
    });
  });

  it("unseals an oauth credential to an access-token secret", () => {
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
    expect(unsealMailAccountSecret(credential, "mail-account-1", key)).toEqual({
      kind: "oauth",
      accessToken: "ya29.the-access-token",
    });
  });
});

describe("toImapAuth", () => {
  it("gives imapflow a plain password auth option for a password secret", () => {
    expect(toImapAuth("vic@mail.test", { kind: "password", password: "swordfish" })).toEqual({
      user: "vic@mail.test",
      pass: "swordfish",
    });
  });

  it("gives imapflow an accessToken auth option (XOAUTH2) for an oauth secret", () => {
    expect(toImapAuth("vic@mail.test", { kind: "oauth", accessToken: "ya29.token" })).toEqual({
      user: "vic@mail.test",
      accessToken: "ya29.token",
    });
  });
});

describe("toSmtpAuth", () => {
  it("gives nodemailer a plain password auth option for a password secret", () => {
    expect(toSmtpAuth("vic@mail.test", { kind: "password", password: "swordfish" })).toEqual({
      user: "vic@mail.test",
      pass: "swordfish",
    });
  });

  it("gives nodemailer an OAuth2-typed auth option for an oauth secret", () => {
    expect(toSmtpAuth("vic@mail.test", { kind: "oauth", accessToken: "ya29.token" })).toEqual({
      type: "OAuth2",
      user: "vic@mail.test",
      accessToken: "ya29.token",
    });
  });
});
