/**
 * Minimal RFC 5322 / MIME builders for tests that APPEND real messages to
 * GreenMail (docs/dev-setup.md). Hand-rolled on purpose: the ingest path is
 * what is under test, so its fixtures must not come from the same library it
 * parses with.
 */

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
}

const CRLF = "\r\n";

export function buildTestMessage(input: TestMessageInput): string {
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

  if (input.text !== undefined && input.html !== undefined) {
    const boundary = "mail-test-boundary";
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
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
    return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
  }

  const isHtml = input.html !== undefined;
  headers.push(`Content-Type: text/${isHtml ? "html" : "plain"}; charset="utf-8"`);
  headers.push("Content-Transfer-Encoding: 8bit");
  return `${headers.join(CRLF)}${CRLF}${CRLF}${(isHtml ? input.html : input.text) ?? ""}${CRLF}`;
}
