import { eq } from "drizzle-orm";
import type { ImapFlow } from "imapflow";
import type { Db } from "../db/client.js";
import { messages } from "../db/schema.js";
import type { MessageBodyParts } from "./body-structure.js";
import { sanitizeMessageHtml } from "./sanitize.js";
import { deriveSnippet } from "./snippet.js";
import { refreshThreadRollups } from "./thread-rollup.js";

/**
 * Fetching, cleaning and storing a message body (#34).
 *
 * ADR-0005 makes bodies **lazy**: the backfill stores headers for everything
 * and bodies arrive later, behind #36's run-once sweep and the Index
 * Watermark. This module is the single place a body ever becomes a stored
 * row, which is what lets two invariants hold without anyone remembering
 * them:
 *
 * - `messages.body_html` is always sanitizer output, never sender HTML.
 * - The **Snippet is derived exactly once**, here, at the moment the body
 *   first lands (CONTEXT.md). A second fetch of the same message will not
 *   recompute it.
 */

/** Past this a "body" is a payload, not prose; the part is truncated rather than refused. */
const MAX_BODY_BYTES = 2_000_000;

export interface FetchedMessageBody {
  text: string | null;
  /** Already sanitized — `sanitizeMessageHtml` has run. */
  html: string | null;
}

/**
 * Downloads a message's text alternatives from the currently-open mailbox.
 * Only the `text/plain` and `text/html` parts are fetched, never the whole
 * message: attachment bytes are fetch-through at read time (poc-spec.md
 * §Compose & sending, "no received-attachment caching") and pulling them
 * here would multiply the backfill's bandwidth by the size of the corpus's
 * attachments.
 */
export async function fetchMessageBody(
  client: ImapFlow,
  uid: number,
  parts: MessageBodyParts,
): Promise<FetchedMessageBody> {
  const [text, html] = await Promise.all([
    parts.textPart ? downloadTextPart(client, uid, parts.textPart) : Promise.resolve(null),
    parts.htmlPart ? downloadTextPart(client, uid, parts.htmlPart) : Promise.resolve(null),
  ]);

  return { text, html: html === null ? null : sanitizeMessageHtml(html) };
}

async function downloadTextPart(
  client: ImapFlow,
  uid: number,
  part: string,
): Promise<string | null> {
  const { meta, content } = await client.download(String(uid), part, {
    uid: true,
    maxBytes: MAX_BODY_BYTES,
  });

  const chunks: Buffer[] = [];
  for await (const chunk of content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  if (chunks.length === 0) return null;

  const decoded = decodeText(Buffer.concat(chunks), meta.charset);
  return meta.flowed ? unfoldFlowed(decoded, meta.delSp === true) : decoded;
}

/**
 * Decodes body bytes using the charset the server declared. Node's
 * `TextDecoder` covers the WHATWG encoding set — which is every charset that
 * shows up in real mail — and throws on a label it does not know, so an
 * exotic or mistyped `charset=` degrades to UTF-8 rather than losing the
 * body.
 */
export function decodeText(bytes: Buffer, charset: string | undefined): string {
  const label = charset?.trim();
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Fall through to UTF-8.
    }
  }
  return bytes.toString("utf8");
}

/**
 * Undoes RFC 3676 `format=flowed` wrapping: a line ending in a space is a
 * soft break and joins the next one, `delSp` says the space itself was
 * padding, and a leading space is stuffing that has to come off. Without
 * this a flowed message's Snippet is its first ~72 characters followed by a
 * hard newline in the middle of a sentence.
 */
export function unfoldFlowed(text: string, delSp: boolean): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let pending = "";

  for (const raw of lines) {
    // Space-stuffing (RFC 3676 §4.4): one leading space is transport
    // padding, not content.
    const line = raw.startsWith(" ") ? raw.slice(1) : raw;
    const soft = line.endsWith(" ") && line.trim() !== "";
    if (soft) {
      pending += delSp ? line.slice(0, -1) : line;
      continue;
    }
    output.push(pending + line);
    pending = "";
  }
  if (pending) output.push(pending);
  return output.join("\n");
}

/**
 * Writes a fetched body to its message and derives the Snippet if — and only
 * if — the message does not already have one. A message whose body is
 * re-fetched (a UIDVALIDITY rebuild, a manual refresh) keeps the Snippet it
 * was first stored with, which is what CONTEXT.md's "derived once" buys:
 * every surface previewing that message shows the same words forever.
 *
 * Refreshes the Thread rollup, because the list row's Snippet is the newest
 * message's.
 */
export async function storeMessageBody(
  db: Db,
  messageId: string,
  body: FetchedMessageBody,
): Promise<void> {
  const [current] = await db
    .select({ threadId: messages.threadId, snippet: messages.snippet })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!current) return;

  await db
    .update(messages)
    .set({
      bodyText: body.text,
      bodyHtml: body.html,
      bodyFetchedAt: new Date(),
      snippet: current.snippet ?? deriveSnippet(body),
      updatedAt: new Date(),
    })
    .where(eq(messages.id, messageId));

  await refreshThreadRollups(db, [current.threadId]);
}
