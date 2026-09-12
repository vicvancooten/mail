import { HTML_QUOTE_VENDOR_DIV_CLASSES, stripQuotedHistory } from "@mail/shared";

/**
 * Snippet derivation (CONTEXT.md: "the short plain-text opening of a
 * message, with quoted and forwarded history stripped ... Derived once when
 * the message is first stored, so every surface that previews it shows the
 * same words").
 *
 * "Once" is enforced by the caller: `sync/bodies.ts` derives a Snippet at
 * the moment a message's body first lands and never again. Everything in
 * this file is pure so that rule is testable without a mailbox.
 *
 * The quote/forward stripping itself (`stripQuotedHistory`) moved to
 * `@mail/shared` (#291): the Mail App's reading pane hides the same history
 * behind a "Show quoted text" toggle, and needs the exact rule this Snippet
 * was already built from rather than a second copy that could drift.
 */

/** Long enough for two lines of a list row on a wide desktop, short enough to stay cheap in a delta. */
const SNIPPET_LENGTH = 280;

/** Container-level elements whose content is quoted history, not this message. */
const HTML_QUOTE_BLOCKS = new RegExp(
  `<blockquote\\b[\\s\\S]*?<\\/blockquote>|<div\\b[^>]*(?:${HTML_QUOTE_VENDOR_DIV_CLASSES})[^>]*>[\\s\\S]*$`,
  "gi",
);

/** Elements whose text is machinery, never prose. */
const HTML_NON_PROSE = /<(script|style|head|title|noscript)\b[\s\S]*?<\/\1>/gi;

/** Tags that end a line when HTML is flattened to text. */
const HTML_LINE_BREAKS = /<\/?(?:br|p|div|tr|li|h[1-6]|table|blockquote|pre|hr)\b[^>]*>/gi;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/**
 * Flattens sanitized HTML to the plain text a Snippet is cut from. This is a
 * preview-grade conversion, not a renderer: it exists so a message with no
 * `text/plain` alternative still previews, and it runs on output that has
 * already been through `sanitizeMessageHtml`.
 */
export function htmlToPreviewText(html: string): string {
  return decodeEntities(
    html
      .replace(HTML_NON_PROSE, " ")
      .replace(HTML_QUOTE_BLOCKS, " ")
      .replace(HTML_LINE_BREAKS, "\n")
      .replace(/<[^>]*>/g, " "),
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      safeFromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/**
 * Zero-width space, non-joiner, joiner and the byte-order mark. Marketing
 * mail pads its preheader with runs of these so the inbox preview shows
 * different words than the message opens with; a Snippet of invisible
 * characters is the exact failure this removes.
 */
const INVISIBLE_PADDING = /\u200B|\u200C|\u200D|\uFEFF/g;

export interface SnippetSource {
  /** The `text/plain` alternative, when the message had one. */
  text?: string | null;
  /** The already-sanitized `text/html` alternative — never raw sender HTML. */
  html?: string | null;
}

/**
 * Derives the Snippet for one message. Prefers the `text/plain` alternative,
 * because it is what the sender's client chose to say without markup; falls
 * back to flattening the sanitized HTML. Returns `null` when there is
 * nothing to preview, so a caller can tell "no body yet" from "a body that
 * is genuinely empty".
 */
export function deriveSnippet({ text, html }: SnippetSource): string | null {
  const plain = text?.trim() ? stripQuotedHistory(text) : "";
  const source = plain.trim() ? plain : html ? stripQuotedHistory(htmlToPreviewText(html)) : "";

  const collapsed = source.replace(INVISIBLE_PADDING, "").replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length <= SNIPPET_LENGTH
    ? collapsed
    : `${collapsed.slice(0, SNIPPET_LENGTH).trimEnd()}…`;
}
