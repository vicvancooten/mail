import type { MessageStructureObject } from "imapflow";
import type { MessageAttachment } from "../db/schema.js";

/**
 * Reading a message's BODYSTRUCTURE (#34): which part is the body worth
 * fetching, and what is hanging off it.
 *
 * ADR-0005's backfill fetches headers for everything and bodies lazily, so
 * this runs at header time — BODYSTRUCTURE arrives in the same FETCH as the
 * envelope, costs nothing extra, and is what lets the attachment pill and
 * the Search Index's filename weighting (ADR-0016, D) exist long before the
 * body itself does.
 */

export interface MessageBodyParts {
  /** IMAP part id of the `text/plain` alternative, if the message has one. */
  textPart: string | null;
  /** IMAP part id of the `text/html` alternative, if the message has one. */
  htmlPart: string | null;
  attachments: MessageAttachment[];
}

/**
 * A non-multipart message has no part numbering of its own; RFC 3501 says
 * `BODY[1]` addresses its single body. ImapFlow leaves `part` undefined on
 * such a root node, so this is where that gets a name.
 */
const SINGLE_PART_ID = "1";

export function readBodyParts(structure: MessageStructureObject | undefined): MessageBodyParts {
  const result: MessageBodyParts = { textPart: null, htmlPart: null, attachments: [] };
  if (!structure) return result;
  walk(structure, result, true);
  return result;
}

function walk(node: MessageStructureObject, result: MessageBodyParts, isRoot: boolean): void {
  if (node.childNodes?.length) {
    for (const child of node.childNodes) walk(child, result, false);
    return;
  }

  const partId = node.part ?? (isRoot ? SINGLE_PART_ID : null);
  if (!partId) return;

  const mimeType = (node.type ?? "application/octet-stream").toLowerCase();
  const filename = readFilename(node);
  const disposition = node.disposition?.toLowerCase();

  // A text part with a filename or an `attachment` disposition is a file the
  // sender attached (a .txt, an .eml quote), not the message's own body.
  const isBodyCandidate = !filename && disposition !== "attachment";

  if (isBodyCandidate && mimeType === "text/plain" && !result.textPart) {
    result.textPart = partId;
    return;
  }
  if (isBodyCandidate && mimeType === "text/html" && !result.htmlPart) {
    result.htmlPart = partId;
    return;
  }

  result.attachments.push({
    part: partId,
    filename,
    mimeType,
    sizeBytes: typeof node.size === "number" ? node.size : null,
    // RFC 2392: a `cid:` URL references this value with the brackets off.
    contentId: node.id ? node.id.replace(/^<|>$/g, "") : null,
    inline: disposition === "inline" || (disposition !== "attachment" && node.id !== undefined),
    encoding: node.encoding ? node.encoding.toLowerCase() : null,
  });
}

function readFilename(node: MessageStructureObject): string | null {
  const fromDisposition = node.dispositionParameters?.filename;
  const fromContentType = node.parameters?.name;
  const raw = fromDisposition ?? fromContentType;
  return raw ? raw.trim() || null : null;
}

/**
 * Whether one attachment is a real, User-facing file rather than a `cid:`
 * body reference's backing part. An inline part that carries a `Content-ID`
 * only exists to satisfy a `cid:` reference in the body, and counting those
 * would put a paperclip — or an attachment-panel entry (#41) — on every HTML
 * newsletter. An inline part with no `Content-ID` is what Apple Mail sends
 * when a User drops a file into the body — a real attachment, and counted.
 */
export function isRealAttachment(attachment: MessageAttachment): boolean {
  return !attachment.inline || attachment.contentId === null;
}

/** Whether a message should show the attachment pill — see `isRealAttachment`. */
export function hasRealAttachments(attachments: MessageAttachment[]): boolean {
  return attachments.some(isRealAttachment);
}
