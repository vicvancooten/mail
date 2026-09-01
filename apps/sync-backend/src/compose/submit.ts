import nodemailer, { type Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import type { CompositionRow } from "../db/schema.js";
import { unsealPasswordCredential } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { buildMime, composeMailOptions } from "./draft-mime.js";

/**
 * SMTP submission for one claimed Pending Send (#46, ADR-0007) — the part
 * that talks to a mail server and classifies what it says back. The state
 * machine around it is `compose/pending-send.ts`; the loop that drives both
 * is `compose/send-sweeper.ts`.
 *
 * Everything here is deliberately *outside* the claim: by the time this runs
 * the Composition is already `submitting` with a durable `Message-ID`
 * (compose-spec: "the Sync Backend mints the `Message-ID` ... before handing
 * anything to Nodemailer, so a transient-failure retry can never produce two
 * messages with two ids"), so a crash mid-submission resumes as a retry of
 * the same message rather than as a new one.
 */

/** Matches `mail-accounts/verify.ts` — a submission that wedges longer than this is not going to land. */
const SMTP_TIMEOUT_MS = 30_000;

/**
 * How a submission failed. The three-way split is ADR-0007's:
 *
 * - `transient` retries with backoff **inside** `submitting`;
 * - `permanent` fails the send and restores it as a badged Draft;
 * - `reauth` holds it indefinitely, consistent with the rule that queued
 *   Optimistic Actions wait rather than fail on a Needs Reauth Mail Account.
 */
export type SubmitFailureKind = "transient" | "permanent" | "reauth";

export type SubmitResult =
  | { ok: true; mime: Buffer }
  | { ok: false; kind: SubmitFailureKind; detail: string };

/**
 * The transport seam. Production hands SMTP; a test hands a function that
 * answers with whatever a mail server would have — which is the only way to
 * exercise the permanent-rejection path, since GreenMail accepts everything
 * (docs/dev-setup.md).
 */
export type SendMail = (options: Mail.Options) => Promise<unknown>;

export interface SubmitOptions {
  /** `env.MAIL_CREDENTIAL_KEY` already hashed to a key (`deriveCredentialKey`). */
  credentialKey: Buffer;
  /** Injected by tests; production builds an SMTP transport from the Mail Account. */
  sendMail?: SendMail;
  /** Pinned so the transmitted copy and the `Sent` copy carry the same `Date`. */
  now?: Date;
}

/**
 * Submits one claimed Composition and returns the MIME to `APPEND` to
 * `Sent` on success.
 *
 * Two MIME builds, not one, and that asymmetry is the point: the transmitted
 * copy carries **no `Bcc` header** and reaches its Bcc recipients through
 * the SMTP envelope ("one envelope recipient per address", compose-spec),
 * while the `Sent` copy keeps the header "so you can see who you Bcc'd".
 * Both are built from the same options at the same pinned `Date` with the
 * same minted `Message-ID`, so the copy in `Sent` is the message that was
 * sent in every respect a recipient could observe.
 */
export async function submitComposition(
  account: MailAccountRow,
  row: CompositionRow,
  { credentialKey, sendMail, now = new Date() }: SubmitOptions,
): Promise<SubmitResult> {
  const messageId = row.messageId ?? undefined;
  const envelopeRecipients = [...row.toAddresses, ...row.ccAddresses, ...row.bccAddresses].map(
    (recipient) => recipient.address,
  );
  if (envelopeRecipients.length === 0) {
    return { ok: false, kind: "permanent", detail: "No recipients on this message." };
  }

  const transmitted: Mail.Options = {
    ...composeMailOptions(row, account.emailAddress, {
      messageId,
      date: now,
      includeBcc: false,
    }),
    envelope: { from: account.emailAddress, to: envelopeRecipients },
  };

  let transport: Transporter | null = null;
  try {
    if (sendMail) {
      await sendMail(transmitted);
    } else {
      transport = build(account, credentialKey);
      await transport.sendMail(transmitted);
    }
  } catch (err) {
    return { ok: false, ...classifyFailure(err) };
  } finally {
    transport?.close();
  }

  const sentCopy = await buildMime(
    composeMailOptions(row, account.emailAddress, { messageId, date: now, includeBcc: true }),
    true,
  );
  return { ok: true, mime: sentCopy };
}

function build(account: MailAccountRow, credentialKey: Buffer): Transporter {
  const password = unsealPasswordCredential(account.credential, account.id, credentialKey);
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    // Same convention as `mail-accounts/verify.ts`: `secure` is implicit TLS
    // on connect, `starttls` requires the upgrade, `none` is GreenMail's
    // plaintext dev listener (docs/dev-setup.md).
    secure: account.smtpSecurity === "tls",
    requireTLS: account.smtpSecurity === "starttls",
    auth: { user: account.username, pass: password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

/**
 * Reads a Nodemailer error the way the SMTP RFC intends: **5xx is
 * permanent, 4xx is transient**, and the User is shown the server's own
 * text verbatim either way (compose-spec: "`550 5.7.1 relay denied` is
 * actionable, 'something went wrong' is not").
 *
 * `EAUTH` is neither: the credential this account is stored with no longer
 * works, which is the Needs Reauth transition, not a property of this
 * message. Anything with no response code at all — a refused connection, a
 * DNS failure, a socket timeout — is transient by default: the mail server
 * never got far enough to reject the *mail*, so the send is still good.
 */
export function classifyFailure(err: unknown): { kind: SubmitFailureKind; detail: string } {
  const detail = failureDetail(err);
  const code = errorProperty(err, "code");
  if (code === "EAUTH") return { kind: "reauth", detail };

  const responseCode = errorProperty(err, "responseCode");
  if (typeof responseCode === "number") {
    if (responseCode >= 500 && responseCode < 600) return { kind: "permanent", detail };
    return { kind: "transient", detail };
  }
  return { kind: "transient", detail };
}

/**
 * The server's own words where there are any. Nodemailer puts the SMTP
 * reply line on `response` (`550 5.7.1 relay denied`) and its own framing on
 * `message`; the former is what compose-spec asks to badge the Draft with.
 */
function failureDetail(err: unknown): string {
  const response = errorProperty(err, "response");
  if (typeof response === "string" && response.trim().length > 0) return response.trim();
  if (err instanceof Error && err.message.trim().length > 0) return err.message.trim();
  return String(err);
}

function errorProperty(err: unknown, key: string): unknown {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as Record<string, unknown>)[key];
}
