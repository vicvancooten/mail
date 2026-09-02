import type { SyntheticMessage } from "./types.js";

/**
 * A deliberately small, fixed placeholder for attachment bytes — real
 * attachment size lives in the message's metadata (Postgres `size_bytes`,
 * IMAP APPEND still carries a real MIME part), but inflating every APPEND to
 * the synthetic `sizeBytes` (up to 4MB) would make the IMAP smoke-load slow
 * for no benefit: attachment *content* isn't in scope for this benchmark
 * (docs/poc-scope.md's Search section excludes it from indexing).
 */
const ATTACHMENT_FILLER_B64 = Buffer.alloc(1024, 0x41).toString("base64");

/** Builds a minimal-but-valid RFC 822 message for IMAP APPEND. */
export function buildRfc822(message: SyntheticMessage): string {
  const boundaryAlt = `altbnd_${message.id}`;
  const boundaryMixed = `mixbnd_${message.id}`;

  const altBody = message.bodyHtml
    ? [
        `--${boundaryAlt}`,
        `Content-Type: text/plain; charset="utf-8"`,
        "",
        message.bodyText,
        `--${boundaryAlt}`,
        `Content-Type: text/html; charset="utf-8"`,
        "",
        message.bodyHtml,
        `--${boundaryAlt}--`,
      ].join("\r\n")
    : message.bodyText;

  const baseHeaders = [
    `From: ${message.fromAddress}`,
    `To: ${message.toAddresses.join(", ")}`,
    `Subject: ${message.subject}`,
    `Date: ${message.sentAt.toUTCString()}`,
    `Message-ID: <${message.id}@corpus-bench.example>`,
    "MIME-Version: 1.0",
  ];

  if (message.attachments.length === 0) {
    const contentType = message.bodyHtml
      ? `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`
      : `Content-Type: text/plain; charset="utf-8"`;
    return [...baseHeaders, contentType, "", altBody].join("\r\n");
  }

  const attachmentParts = message.attachments.map((a) =>
    [
      `--${boundaryMixed}`,
      `Content-Type: ${a.mimeType}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "",
      ATTACHMENT_FILLER_B64,
    ].join("\r\n"),
  );

  const mixedBody = [
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    altBody,
    ...attachmentParts,
    `--${boundaryMixed}--`,
  ].join("\r\n");

  return [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    "",
    mixedBody,
  ].join("\r\n");
}
