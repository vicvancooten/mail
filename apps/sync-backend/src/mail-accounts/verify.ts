import type { MailAccountConnection } from "@mail/shared";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { type MailAccountSecret, toImapAuth, toSmtpAuth } from "./credential-auth.js";
import { type DetectedMailAccountServerKind, detectServerKind } from "./server-kind.js";

/** A few seconds per docs/research/0004 §4's "short, fixed timeout, move on" guidance. */
const VERIFY_TIMEOUT_MS = 8000;

export interface VerifyMailAccountInput {
  imap: MailAccountConnection;
  smtp: MailAccountConnection;
  username: string;
  /**
   * A `{ kind: "password", password }` shape covers both the add-account
   * route's plaintext body and a reauth's re-entered password; `{ kind:
   * "oauth", accessToken }` verifies a Grant — unseal it with
   * `credential-auth.ts#unsealMailAccountSecret` first, since a Grant only
   * ever exists sealed (nothing here reads `MailAccountCredential` directly).
   */
  credential: MailAccountSecret;
}

export type VerifyMailAccountResult =
  | { ok: true; serverKind: DetectedMailAccountServerKind }
  | { ok: false; reason: "credentials_rejected" | "connection_failed"; detail: string };

/**
 * Live IMAP+SMTP verify before save (poc-spec.md §Mail Accounts): adding or
 * re-authing a Mail Account never writes a row (or clears Needs Reauth)
 * without both protocols actually accepting the credential first. Runs both
 * checks regardless of whether the first fails, so a bad password reports
 * as `credentials_rejected` even if, say, the SMTP host is also wrong —
 * IMAP's answer is more specific and takes priority when the two disagree.
 */
export async function verifyMailAccountCredentials(
  input: VerifyMailAccountInput,
): Promise<VerifyMailAccountResult> {
  const [imapResult, smtpResult] = await Promise.all([verifyImap(input), verifySmtp(input)]);

  if (!imapResult.ok) {
    return imapResult;
  }
  if (!smtpResult.ok) {
    return smtpResult;
  }
  return imapResult;
}

async function verifyImap({
  imap,
  username,
  credential,
}: VerifyMailAccountInput): Promise<VerifyMailAccountResult> {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    // `secure: true` is implicit TLS on connect; for `starttls`/`none` the
    // client connects plaintext and upgrades opportunistically if the
    // server offers STARTTLS (imapflow's own default), which is exactly
    // what GreenMail's plaintext dev listener needs (docs/dev-setup.md).
    secure: imap.security === "tls",
    auth: toImapAuth(username, credential),
    logger: false,
    socketTimeout: VERIFY_TIMEOUT_MS,
  });

  try {
    await client.connect();
    // Capabilities are known as soon as `connect()` resolves (the
    // greeting/CAPABILITY exchange), so this needs no command of its own
    // and can run before `logout()` (#121, ADR-0020).
    const serverKind = detectServerKind(client);
    await client.logout();
    return { ok: true, serverKind };
  } catch (err) {
    // imapflow's `AuthenticationFailure` class isn't actually exported from
    // its public API (only its .d.ts claims it is) — `authenticationFailed`
    // is the one property its own type declaration guarantees on the thrown
    // error, so that's what this duck-types on instead of `instanceof`.
    if (isImapAuthFailure(err)) {
      return { ok: false, reason: "credentials_rejected", detail: err.message };
    }
    return { ok: false, reason: "connection_failed", detail: errorMessage(err) };
  } finally {
    client.close();
  }
}

function isImapAuthFailure(err: unknown): err is Error & { authenticationFailed: true } {
  return err instanceof Error && "authenticationFailed" in err && err.authenticationFailed === true;
}

type VerifySmtpResult =
  | { ok: true }
  | { ok: false; reason: "credentials_rejected" | "connection_failed"; detail: string };

async function verifySmtp({
  smtp,
  username,
  credential,
}: VerifyMailAccountInput): Promise<VerifySmtpResult> {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    auth: toSmtpAuth(username, credential),
    connectionTimeout: VERIFY_TIMEOUT_MS,
    greetingTimeout: VERIFY_TIMEOUT_MS,
    socketTimeout: VERIFY_TIMEOUT_MS,
  });

  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    if (isNodemailerError(err) && err.code === "EAUTH") {
      return { ok: false, reason: "credentials_rejected", detail: errorMessage(err) };
    }
    return { ok: false, reason: "connection_failed", detail: errorMessage(err) };
  } finally {
    transport.close();
  }
}

function isNodemailerError(err: unknown): err is Error & { code?: string } {
  return err instanceof Error;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
