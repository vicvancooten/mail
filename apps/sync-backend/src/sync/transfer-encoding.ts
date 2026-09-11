/**
 * Decodes a MIME part's `Content-Transfer-Encoding` against the bytes a raw
 * `bodyParts` FETCH returns. Shared by `routes/messages.ts` (a fetch-through
 * attachment download) and `invitations/store.ts` (a calendar/TNEF part
 * download) — both need the same gotcha this module's original home
 * (`routes/messages.ts#fetchAttachmentBytes`) documented: `ImapFlow#download()`'s
 * own encoding auto-detection reads it from a second, companion
 * `BODY[<part>.MIME]` FETCH at download time, and that lookup was found to
 * come back empty for a nested (dotted) part id against GreenMail — silently
 * handing back still-encoded bytes instead of decoding them. Decoding against
 * the value ingest already parsed from BODYSTRUCTURE (`sync/body-structure.ts`,
 * stored on `MessageAttachment`) sidesteps that second, unreliable FETCH
 * entirely.
 */

export function decodeTransferEncoding(raw: Buffer, encoding: string | null): Buffer {
  switch (encoding) {
    case "base64":
      return Buffer.from(raw.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
    case "quoted-printable":
      return decodeQuotedPrintable(raw.toString("ascii"));
    default:
      // `7bit`/`8bit`/`binary`/unset: already the real bytes.
      return raw;
  }
}

/** RFC 2045 §6.7: `=XX` hex-escapes a byte, `=` at end-of-line is a soft break (removed, not a byte). */
export function decodeQuotedPrintable(input: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "=") {
      if (input[i + 1] === "\r" && input[i + 2] === "\n") {
        i += 2;
        continue;
      }
      if (input[i + 1] === "\n") {
        i += 1;
        continue;
      }
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push((ch ?? "").charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}
