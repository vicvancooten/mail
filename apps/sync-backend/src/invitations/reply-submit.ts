import type { Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import { buildMime } from "../compose/draft-mime.js";
import { buildSmtpTransport, classifyFailure, type SubmitFailureKind } from "../compose/submit.js";
import type { ImipReplyRow } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";

/**
 * SMTP submission for one claimed `imip_replies` row (#241, ADR-0027) —
 * `compose/submit.ts#submitComposition`'s own shape, minus everything about
 * a `Composition` (attachments, drafts, Bcc) it has no use for: the whole
 * message here is the plaintext body plus one `text/calendar; method=REPLY`
 * part Nodemailer's own `icalEvent` option builds (RFC 6047's exact shape,
 * the same one a calendar client sends).
 */

const RESPONSE_LABEL: Record<ImipReplyRow["responseStatus"], string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentatively accepted",
};

export type SendMail = (options: Mail.Options) => Promise<unknown>;

export interface SubmitReplyOptions {
  credentialKey: Buffer;
  sendMail?: SendMail;
  now?: Date;
}

export type SubmitReplyResult =
  | { ok: true; mime: Buffer }
  | { ok: false; kind: SubmitFailureKind; detail: string };

function replyMailOptions(account: MailAccountRow, row: ImipReplyRow, now: Date): Mail.Options {
  const subject = `${RESPONSE_LABEL[row.responseStatus]}: ${row.eventTitle ?? "(no title)"}`;
  return {
    from: account.emailAddress,
    to: row.organizerAddress,
    subject,
    text: `${RESPONSE_LABEL[row.responseStatus]}.`,
    date: now,
    ...(row.messageId ? { messageId: `<${row.messageId}>` } : {}),
    icalEvent: {
      method: "REPLY",
      content: row.icsText,
    },
  };
}

/** Submits one claimed Reply, returning the MIME to `APPEND` to `Sent` on success — `compose/submit.ts#submitComposition`'s own two-step shape, with no Bcc distinction to make (a `REPLY` never carries one). */
export async function submitImipReply(
  account: MailAccountRow,
  row: ImipReplyRow,
  { credentialKey, sendMail, now = new Date() }: SubmitReplyOptions,
): Promise<SubmitReplyResult> {
  const options: Mail.Options = {
    ...replyMailOptions(account, row, now),
    envelope: { from: account.emailAddress, to: [row.organizerAddress] },
  };

  let transport: Transporter | null = null;
  try {
    if (sendMail) {
      await sendMail(options);
    } else {
      transport = buildSmtpTransport(account, credentialKey);
      await transport.sendMail(options);
    }
  } catch (err) {
    return { ok: false, ...classifyFailure(err) };
  } finally {
    transport?.close();
  }

  const mime = await buildMime(replyMailOptions(account, row, now));
  return { ok: true, mime };
}
