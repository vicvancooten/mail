import {
  type MailAccountCredential,
  unsealOAuthAccessToken,
  unsealPasswordCredential,
} from "./credential-crypto.js";

/**
 * "Give me auth for this connection" (#114): the one place that turns a
 * `MailAccountCredential`'s `kind` into a plaintext secret — a `password`
 * unseals to the IMAP/SMTP password it always has; an `oauth` credential (the
 * Grant, ADR-0021) unseals to the access token XOAUTH2 sends instead of a
 * password. Neither `sync/imap-connection.ts` nor `compose/submit.ts` unseals
 * a credential directly any more; they call this and then adapt the result to
 * their own client library's auth shape with `toImapAuth`/`toSmtpAuth`.
 */
export type MailAccountSecret =
  | { kind: "password"; password: string }
  | { kind: "oauth"; accessToken: string };

/** Unseals whichever secret this credential's `kind` actually carries. */
export function unsealMailAccountSecret(
  credential: MailAccountCredential,
  mailAccountId: string,
  key: Buffer,
): MailAccountSecret {
  if (credential.kind === "oauth") {
    return { kind: "oauth", accessToken: unsealOAuthAccessToken(credential, mailAccountId, key) };
  }
  return { kind: "password", password: unsealPasswordCredential(credential, mailAccountId, key) };
}

/** imapflow's auth option: `pass` for a password, `accessToken` for XOAUTH2 — never both. */
export interface ImapAuthOption {
  user: string;
  pass?: string;
  accessToken?: string;
}

export function toImapAuth(user: string, secret: MailAccountSecret): ImapAuthOption {
  return secret.kind === "oauth"
    ? { user, accessToken: secret.accessToken }
    : { user, pass: secret.password };
}

/**
 * Nodemailer's auth option: a plain password needs no `type`; XOAUTH2 needs
 * `type: "OAuth2"` alongside `accessToken` or nodemailer falls back to
 * treating `accessToken` as ignored and trying plain auth with no password.
 */
export interface SmtpAuthOption {
  user: string;
  pass?: string;
  type?: "OAuth2";
  accessToken?: string;
}

export function toSmtpAuth(user: string, secret: MailAccountSecret): SmtpAuthOption {
  return secret.kind === "oauth"
    ? { type: "OAuth2", user, accessToken: secret.accessToken }
    : { user, pass: secret.password };
}
