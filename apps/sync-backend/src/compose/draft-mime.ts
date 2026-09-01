import type { Recipient } from "@mail/shared";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type { CompositionRow } from "../db/schema.js";
import { serializeComposeHtml, serializeComposePlaintext } from "./mail-serializer.js";

/**
 * Turns a Composition into the mail options Nodemailer builds MIME from —
 * the one place that decides what a Composition *is* as a message, shared by
 * the IMAP `Drafts` export (ADR-0012) and the send path (#46) so the mail
 * the recipient gets and the draft another IMAP client reads are the same
 * document rendered the same way.
 *
 * **Always** `multipart/alternative` — `text/plain` beside `text/html` —
 * even for an entirely unformatted document (ADR-0013: a
 * plain-document-only branch is a second send path exercised rarely and
 * therefore breaking quietly). Nodemailer's `MailComposer` is what actually
 * builds that MIME shape; this file's own job is only choosing what goes
 * into it, never hand-rolling multipart boundaries.
 *
 * No attachments yet (#48's Blob Store) and no inline images, so there is no
 * outer `multipart/mixed`/`multipart/related` wrapping here — ADR-0012's
 * full nesting only appears once attachments/inline images exist to nest
 * around.
 */

export interface ComposeMailOptions {
  /**
   * The `Message-ID` the Sync Backend minted at claim time, without angle
   * brackets (`compose/pending-send.ts#mintMessageId`). Omitted for a draft
   * export, where Nodemailer's own id is fine — a draft is not a message
   * anyone threads against yet, and the id that matters is the one minted at
   * submission (compose-spec §Threading headers).
   */
  messageId?: string;
  /** Pinned so the transmitted copy and the `Sent` copy carry the same `Date`. */
  date?: Date;
  /**
   * Whether the `Bcc` header goes into the MIME. `true` for a Draft and for
   * the `Sent` copy — compose-spec: Bcc is "kept in the Draft, kept in the
   * `Sent` APPEND (so you can see who you Bcc'd), stripped from the
   * transmitted headers". The transmitted copy passes `false` and carries
   * its Bcc recipients in the SMTP envelope instead.
   */
  includeBcc: boolean;
}

export function composeMailOptions(
  row: CompositionRow,
  fromAddress: string,
  { messageId, date, includeBcc }: ComposeMailOptions,
): Mail.Options {
  return {
    from: fromAddress,
    to: toAddressList(row.toAddresses),
    cc: toAddressList(row.ccAddresses),
    ...(includeBcc ? { bcc: toAddressList(row.bccAddresses) } : {}),
    subject: row.subject,
    ...(messageId ? { messageId: `<${messageId}>` } : {}),
    ...(date ? { date } : {}),
    text: serializeComposePlaintext(row.document),
    html: serializeComposeHtml(row.document),
  };
}

/**
 * Builds the raw MIME message for a set of options — `MailComposer` and
 * nothing else.
 *
 * `keepBcc` is Nodemailer's own MimeNode option for *not* stripping the `Bcc`
 * header at build time, set on the compiled root because `MailComposer` does
 * not forward it. Stripping is the right default for anything going on the
 * wire; the two copies that are the User's own — the IMAP `Drafts` export and
 * the `Sent` APPEND — want the header kept, so the User can see who they
 * Bcc'd (ADR-0012, compose-spec §Recipients).
 */
export async function buildMime(options: Mail.Options, keepBcc = false): Promise<Buffer> {
  const node = new MailComposer(options).compile();
  node.keepBcc = keepBcc;
  return node.build();
}

/** The MIME a Composition pushes to IMAP `Drafts` (ADR-0012). Bcc kept: it is the User's own copy. */
export async function buildDraftMime(row: CompositionRow, fromAddress: string): Promise<Buffer> {
  return buildMime(composeMailOptions(row, fromAddress, { includeBcc: true }), true);
}

function toAddressList(recipients: Recipient[]): { name: string; address: string }[] | undefined {
  if (recipients.length === 0) return undefined;
  return recipients.map((recipient) => ({
    name: recipient.name ?? "",
    address: recipient.address,
  }));
}
