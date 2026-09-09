import type { MailAccountConnection } from "@mail/shared";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { type MailAccountSecret, toImapAuth, toSmtpAuth } from "./credential-auth.js";
import { type DetectedMailAccountServerKind, detectServerKind } from "./server-kind.js";

/** A few seconds per docs/research/0004 §4's "short, fixed timeout, move on" guidance — governs each individual attempt (see `withOneRetry` below for the bounded retry sitting on top of that). */
const VERIFY_TIMEOUT_MS = 8000;

/** How long to wait before the one retry `withOneRetry` allows a `connection_failed` result. */
const VERIFY_RETRY_DELAY_MS = 300;

/**
 * One bounded retry for a `connection_failed` result specifically —
 * `credentials_rejected` is authoritative on the first try, nothing to
 * retry there. Docs/research/0004 §4's "short, fixed timeout, move on" still
 * governs each individual attempt's own timeout (`VERIFY_TIMEOUT_MS`) and
 * still rules out an unbounded retry loop; this covers just the single
 * transient reset/refusal a real server can hand back momentarily (seen in
 * CI against GreenMail: a connection reset mid-`LOGIN`), which "move on"
 * alone would otherwise report as a hard `connection_failed` on a server
 * that's actually fine a moment later. Each attempt is a fresh call — the
 * caller builds a brand new `ImapFlow`/`Transporter` per invocation — so a
 * retry never reuses a connection that just failed.
 */
async function withOneRetry<T extends { ok: boolean; reason?: string }>(
  attempt: () => Promise<T>,
): Promise<T> {
  const first = await attempt();
  if (first.ok || first.reason !== "connection_failed") return first;
  await new Promise((resolve) => setTimeout(resolve, VERIFY_RETRY_DELAY_MS));
  return attempt();
}

export interface VerifyMailAccountInput {
  imap: MailAccountConnection;
  smtp: MailAccountConnection;
  username: string;
  /**
   * A `{ kind: "password", password }` shape covers both the add-account
   * route's plaintext body and a reauth's re-entered password; `{ kind:
   * "oauth", accessToken }` verifies a Grant — unseal it with
   * `credential-auth.ts#unsealMailAccountSecret` first, since a Grant only
   * ever exists sealed (nothing here reads `ConnectedAccountCredential` directly).
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

function verifyImap(input: VerifyMailAccountInput): Promise<VerifyMailAccountResult> {
  return withOneRetry(() => attemptVerifyImap(input));
}

async function attemptVerifyImap({
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
    // Synchronous and untyped as anything else (`close(): void`) — a
    // `connect()` that never actually established (exactly the
    // `connection_failed` case above, e.g. a reset mid-`LOGIN`) can still
    // leave imapflow's own internal socket-end handling reject an in-flight
    // command promise asynchronously once this tears the socket down, with
    // no handle here to attach a `.catch()` to. That's an imapflow-internal
    // unhandled rejection (their own CLAUDE.md: fixes for it belong
    // upstream), not something this function's own result depends on.
    client.close();
  }
}

function isImapAuthFailure(err: unknown): err is Error & { authenticationFailed: true } {
  return err instanceof Error && "authenticationFailed" in err && err.authenticationFailed === true;
}

type VerifySmtpResult =
  | { ok: true }
  | { ok: false; reason: "credentials_rejected" | "connection_failed"; detail: string };

function verifySmtp(input: VerifyMailAccountInput): Promise<VerifySmtpResult> {
  return withOneRetry(() => attemptVerifySmtp(input));
}

async function attemptVerifySmtp({
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
