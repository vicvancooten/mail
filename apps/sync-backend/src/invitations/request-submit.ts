import type { Transporter } from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import { buildMime } from "../compose/draft-mime.js";
import { buildSmtpTransport, classifyFailure, type SubmitFailureKind } from "../compose/submit.js";
import type { ImipRequestRow } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";

/**
 * SMTP submission for one claimed `imip_requests` row (#242, ADR-0027) —
 * `invitations/reply-submit.ts`'s own shape, addressed to one Attendee
 * instead of the Organizer: the whole message is a plaintext body plus one
 * `text/calendar; method=REQUEST` (or `CANCEL`) part Nodemailer's own
 * `icalEvent` option builds.
 */

const SUBJECT_PREFIX: Record<ImipRequestRow["method"], string> = {
  REQUEST: "Invitation:",
  CANCEL: "Cancelled:",
};

export type SendMail = (options: Mail.Options) => Promise<unknown>;

export interface SubmitRequestOptions {
  credentialKey: Buffer;
  sendMail?: SendMail;
  now?: Date;
}

export type SubmitRequestResult =
  | { ok: true; mime: Buffer }
  | { ok: false; kind: SubmitFailureKind; detail: string };

function requestMailOptions(account: MailAccountRow, row: ImipRequestRow, now: Date): Mail.Options {
  const title = row.eventTitle ?? "(no title)";
  const subject = `${SUBJECT_PREFIX[row.method]} ${title}`;
  const text =
    row.method === "REQUEST"
      ? `You have been invited: ${title}.`
      : `This event has been cancelled: ${title}.`;
  return {
    from: account.emailAddress,
    to: row.attendeeAddress,
    subject,
    text,
    date: now,
    ...(row.messageId ? { messageId: `<${row.messageId}>` } : {}),
    icalEvent: {
      method: row.method,
      content: row.icsText,
    },
  };
}

/** Submits one claimed Request, returning the MIME to `APPEND` to `Sent` on success — `reply-submit.ts#submitImipReply`'s own two-step shape. */
export async function submitImipRequest(
  account: MailAccountRow,
  row: ImipRequestRow,
  { credentialKey, sendMail, now = new Date() }: SubmitRequestOptions,
): Promise<SubmitRequestResult> {
  const options: Mail.Options = {
    ...requestMailOptions(account, row, now),
    envelope: { from: account.emailAddress, to: [row.attendeeAddress] },
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

  const mime = await buildMime(requestMailOptions(account, row, now));
  return { ok: true, mime };
}
