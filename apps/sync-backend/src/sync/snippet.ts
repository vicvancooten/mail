/**
 * Snippet derivation (CONTEXT.md: "the short plain-text opening of a
 * message, with quoted and forwarded history stripped ... Derived once when
 * the message is first stored, so every surface that previews it shows the
 * same words").
 *
 * "Once" is enforced by the caller: `sync/bodies.ts` derives a Snippet at
 * the moment a message's body first lands and never again. Everything in
 * this file is pure so that rule is testable without a mailbox.
 */

/** Long enough for two lines of a list row on a wide desktop, short enough to stay cheap in a delta. */
const SNIPPET_LENGTH = 280;

/**
 * Lines that mean "everything below is history, not this message".
 *
 * Both languages this mailbox actually runs in (ADR-0016 refuses a stemmed
 * search configuration for the same reason) plus the two vendor markers that
 * carry no words at all — Outlook's underscore rule and its
 * `-----Original Message-----` banner.
 */
const QUOTE_MARKERS: RegExp[] = [
  /^>/,
  /^\s*-{2,}\s*(?:original message|oorspronkelijk bericht|forwarded message|doorgestuurd bericht|ursprüngliche nachricht|message d'origine)\s*-{2,}\s*$/i,
  /^_{5,}\s*$/,
  /^\s*-{3,}\s*$/,
];

/** RFC 3676's signature delimiter: a line of exactly `--` (one trailing space allowed). */
const SIGNATURE_DELIMITER = /^--\s?$/;

/**
 * The attribution line a reply client writes above the quote. Real ones wrap
 * across two or three lines when the quoted sender's name and address are
 * long, so this is matched against a *joined* lookahead rather than one line.
 *
 * The verb does not always come last: English puts it at the end ("… Alice
 * <a@x> wrote:") while Dutch and German put the name after it ("Op … schreef
 * Alice <a@x>:"), so the end pattern is "the verb, then anything but a
 * colon, then the colon that closes the line".
 */
const ATTRIBUTION_START = /^\s*(?:on|op|am|le|el)\s/i;
const ATTRIBUTION_END = /\b(?:wrote|schreef|schrieb|a écrit|escribió)\b[^:]*:\s*$/i;

/** How many following lines an attribution may wrap over before it stops counting as one. */
const ATTRIBUTION_LOOKAHEAD = 3;

/** The header block Outlook and friends paste above a forward, in both languages. */
const FORWARD_HEADER_START = /^\s*(?:from|van|von|de)\s*:\s*\S/i;
const FORWARD_HEADER_FOLLOW =
  /^\s*(?:sent|verzonden|gesendet|envoyé|to|aan|an|à|subject|onderwerp|betreff|objet|date|datum|cc)\s*:/i;

/** How many lines after a `From:` line may carry the rest of a pasted header block. */
const FORWARD_HEADER_LOOKAHEAD = 4;

/**
 * Cuts a plain-text body at the first line that starts quoted or forwarded
 * history, returning only what the sender actually wrote this time.
 *
 * Deliberately conservative in one direction and not the other: a marker
 * that is missed costs a Snippet with some quoted text in it, while a false
 * positive silently hides the message's own words. So a bare `From:` line
 * only counts once a second pasted header line confirms it, and a bare
 * `On ...` line only counts once it actually ends in `wrote:`.
 */
export function stripQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (QUOTE_MARKERS.some((marker) => marker.test(line))) {
      return lines.slice(0, i).join("\n");
    }
    if (SIGNATURE_DELIMITER.test(line)) {
      return lines.slice(0, i).join("\n");
    }
    if (ATTRIBUTION_START.test(line) && isWrappedAttribution(lines, i)) {
      return lines.slice(0, i).join("\n");
    }
    if (FORWARD_HEADER_START.test(line) && hasPastedHeaderBlock(lines, i)) {
      return lines.slice(0, i).join("\n");
    }
  }

  return text;
}

function isWrappedAttribution(lines: string[], start: number): boolean {
  let joined = lines[start] ?? "";
  if (ATTRIBUTION_END.test(joined)) return true;
  for (let offset = 1; offset <= ATTRIBUTION_LOOKAHEAD; offset += 1) {
    const next = lines[start + offset];
    if (next === undefined || next.trim() === "") return false;
    joined = `${joined} ${next.trim()}`;
    if (ATTRIBUTION_END.test(joined)) return true;
  }
  return false;
}

function hasPastedHeaderBlock(lines: string[], start: number): boolean {
  for (let offset = 1; offset <= FORWARD_HEADER_LOOKAHEAD; offset += 1) {
    const next = lines[start + offset];
    if (next === undefined) return false;
    if (FORWARD_HEADER_FOLLOW.test(next)) return true;
  }
  return false;
}

/** Container-level elements whose content is quoted history, not this message. */
const HTML_QUOTE_BLOCKS =
  /<blockquote\b[\s\S]*?<\/blockquote>|<div\b[^>]*(?:gmail_quote|yahoo_quoted|moz-cite-prefix|OLK_SRC_BODY_SECTION|divRplyFwdMsg)[^>]*>[\s\S]*$/gi;

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
