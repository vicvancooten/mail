import type { Recipient } from "@mail/shared";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { CompositionRow } from "../db/schema.js";
import { serializeComposeHtml, serializeComposePlaintext } from "./mail-serializer.js";

/**
 * Builds the raw MIME message a Composition pushes to IMAP `Drafts`
 * (ADR-0012). **Always** `multipart/alternative` — `text/plain` beside
 * `text/html` — even for an entirely unformatted document (ADR-0013: a
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
export async function buildDraftMime(row: CompositionRow, fromAddress: string): Promise<Buffer> {
  const composer = new MailComposer({
    from: fromAddress,
    to: toAddressList(row.toAddresses),
    cc: toAddressList(row.ccAddresses),
    bcc: toAddressList(row.bccAddresses),
    subject: row.subject,
    text: serializeComposePlaintext(row.document),
    html: serializeComposeHtml(row.document),
  });
  return composer.compile().build();
}

function toAddressList(recipients: Recipient[]): { name: string; address: string }[] | undefined {
  if (recipients.length === 0) return undefined;
  return recipients.map((recipient) => ({
    name: recipient.name ?? "",
    address: recipient.address,
  }));
}
