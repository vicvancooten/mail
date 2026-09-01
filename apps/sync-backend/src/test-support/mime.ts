/**
 * Minimal RFC 5322 / MIME builders for tests that APPEND real messages to
 * GreenMail (docs/dev-setup.md). Hand-rolled on purpose: the ingest path is
 * what is under test, so its fixtures must not come from the same library it
 * parses with.
 */

export interface TestAttachmentInput {
  filename?: string;
  contentType: string;
  /** Set to make this part resolvable via a `cid:` reference in `html` (RFC 2392 — no angle brackets here). */
  contentId?: string;
  /** `inline` (default for a `contentId`-bearing part) vs. `attachment` — mirrors ADR-0012's MIME shape. */
  disposition?: "inline" | "attachment";
  /** Raw bytes, base64-encoded by this helper — callers pass plain text/binary-as-latin1, not pre-encoded. */
  content: string;
}

export interface TestMessageInput {
  from: string;
  to: string;
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  text?: string;
  html?: string;
  /** `multipart/related` (inline, `cid:`-referenced) and `multipart/mixed` (real) parts, per ADR-0012's shape. */
  attachments?: TestAttachmentInput[];
}

const CRLF = "\r\n";

function headerBlock(input: TestMessageInput): string[] {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${input.messageId}>`,
  ];
  if (input.inReplyTo) headers.push(`In-Reply-To: <${input.inReplyTo}>`);
  if (input.references?.length) {
    headers.push(`References: ${input.references.map((id) => `<${id}>`).join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");
  return headers;
}

/** The `text/plain` + `text/html` alternative body, as a standalone MIME part (headers + body, no envelope). */
function alternativePart(input: TestMessageInput): { contentType: string; body: string } {
  if (input.text !== undefined && input.html !== undefined) {
    const boundary = "mail-test-alt-boundary";
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.text,
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.html,
      `--${boundary}--`,
      "",
    ].join(CRLF);
    return { contentType: `multipart/alternative; boundary="${boundary}"`, body };
  }
  const isHtml = input.html !== undefined;
  return {
    contentType: `text/${isHtml ? "html" : "plain"}; charset="utf-8"`,
    body: (isHtml ? input.html : input.text) ?? "",
  };
}

function attachmentPart(attachment: TestAttachmentInput): string {
  const disposition = attachment.disposition ?? (attachment.contentId ? "inline" : "attachment");
  const lines = [`Content-Type: ${attachment.contentType}`];
  if (attachment.filename) {
    lines[0] += `; name="${attachment.filename}"`;
  }
  lines.push(
    `Content-Disposition: ${disposition}${attachment.filename ? `; filename="${attachment.filename}"` : ""}`,
  );
  if (attachment.contentId) lines.push(`Content-ID: <${attachment.contentId}>`);
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(Buffer.from(attachment.content, "latin1").toString("base64"));
  return lines.join(CRLF);
}

export function buildTestMessage(input: TestMessageInput): string {
  const headers = headerBlock(input);
  const attachments = input.attachments ?? [];

  if (attachments.length === 0) {
    const { contentType, body } = alternativePart(input);
    headers.push(`Content-Type: ${contentType}`);
    return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
  }

  const alt = alternativePart(input);
  const inlineParts = attachments.filter(
    (a) => (a.disposition ?? (a.contentId ? "inline" : "attachment")) === "inline",
  );
  const mixedParts = attachments.filter((a) => !inlineParts.includes(a));

  // multipart/related [ alternative, inline parts ]
  let relatedContentType = alt.contentType;
  let relatedBody = alt.body;
  if (inlineParts.length > 0) {
    const boundary = "mail-test-related-boundary";
    const parts = [
      `--${boundary}`,
      `Content-Type: ${alt.contentType}`,
      "",
      alt.body,
      ...inlineParts.flatMap((part) => [`--${boundary}`, attachmentPart(part)]),
      `--${boundary}--`,
      "",
    ];
    relatedContentType = `multipart/related; boundary="${boundary}"`;
    relatedBody = parts.join(CRLF);
  }

  if (mixedParts.length === 0) {
    headers.push(`Content-Type: ${relatedContentType}`);
    return `${headers.join(CRLF)}${CRLF}${CRLF}${relatedBody}`;
  }

  // multipart/mixed [ (related|alternative), real attachments ]
  const boundary = "mail-test-mixed-boundary";
  const parts = [
    `--${boundary}`,
    `Content-Type: ${relatedContentType}`,
    "",
    relatedBody,
    ...mixedParts.flatMap((part) => [`--${boundary}`, attachmentPart(part)]),
    `--${boundary}--`,
    "",
  ];
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}
