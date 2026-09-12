/**
 * Quoted/forwarded history detection (#291, CONTEXT.md's own Snippet entry:
 * "the short plain-text opening of a message, with quoted and forwarded
 * history stripped"). `stripQuotedHistory` lived only in the Sync Backend's
 * Snippet derivation (`apps/sync-backend/src/sync/snippet.ts`) until #291
 * moved it here, so the Mail App's reading pane can hide the same history
 * behind a "Show quoted text" toggle using the exact rules the Snippet was
 * already built from, rather than a second copy that could drift.
 */

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

function isWrappedAttribution(lines: readonly string[], start: number): boolean {
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

function hasPastedHeaderBlock(lines: readonly string[], start: number): boolean {
  for (let offset = 1; offset <= FORWARD_HEADER_LOOKAHEAD; offset += 1) {
    const next = lines[start + offset];
    if (next === undefined) return false;
    if (FORWARD_HEADER_FOLLOW.test(next)) return true;
  }
  return false;
}

/**
 * The index of the first line where quoted/forwarded history begins, or
 * `lines.length` when the message has none. `stripQuotedHistory` and the
 * HTML splitters below both cut here — sharing this one scan is what keeps
 * "hide the quote" and "preview without the quote" the same rule.
 */
function findQuoteCutLine(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (QUOTE_MARKERS.some((marker) => marker.test(line))) return i;
    if (SIGNATURE_DELIMITER.test(line)) return i;
    if (ATTRIBUTION_START.test(line) && isWrappedAttribution(lines, i)) return i;
    if (FORWARD_HEADER_START.test(line) && hasPastedHeaderBlock(lines, i)) return i;
  }
  return lines.length;
}

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
  return lines.slice(0, findQuoteCutLine(lines)).join("\n");
}

/**
 * A message body split at the same point `stripQuotedHistory` would cut: the
 * sender's own words this time, and — separately, never discarded — the
 * quoted/forwarded history behind them, when there is any.
 */
export interface QuotedHistorySplit {
  /** What the sender actually wrote this time. */
  visible: string;
  /** Quoted/forwarded history, or `null` when the body carries none. */
  quoted: string | null;
}

/**
 * The vendor-specific containers a reply/forward wraps quoted HTML in
 * (`docs/research/0005`'s survey): Gmail's `gmail_quote`, Yahoo's
 * `yahoo_quoted`, Apple Mail's `moz-cite-prefix`, Outlook Web's
 * `OLK_SRC_BODY_SECTION`/`divRplyFwdMsg`. Exported so the Sync Backend's own
 * preview-text flattening (`sync/snippet.ts#htmlToPreviewText`) builds its
 * blanking pattern from this same list rather than keeping a second one that
 * could drift.
 */
export const HTML_QUOTE_VENDOR_DIV_CLASSES =
  "gmail_quote|yahoo_quoted|moz-cite-prefix|OLK_SRC_BODY_SECTION|divRplyFwdMsg";

const HTML_QUOTE_CONTAINER_START = new RegExp(
  `<blockquote\\b[^>]*>|<div\\b[^>]*(?:${HTML_QUOTE_VENDOR_DIV_CLASSES})[^>]*>`,
  "i",
);

/**
 * Splits a native-HTML message body at the first quote container — a
 * `<blockquote>` or one of the vendor-marked `<div>`s above — and treats
 * everything from there to the end as history. The same conservative rule
 * `stripQuotedHistory` applies to plain text: cut at the first sign, never
 * try to look past it for the sender's own words resuming afterward, because
 * a false positive there would hide real content rather than merely leave
 * some quoted text showing.
 */
export function splitQuotedHtml(html: string): QuotedHistorySplit {
  const match = HTML_QUOTE_CONTAINER_START.exec(html);
  if (!match) return { visible: html, quoted: null };
  const quoted = html.slice(match.index).trim();
  if (!quoted) return { visible: html, quoted: null };
  return { visible: html.slice(0, match.index), quoted };
}

/**
 * Splits a message with no native HTML alternative — `bodyHtml` is
 * `plainTextToHtml`'s synthesized markup (`sync/bodies.ts`), exactly one
 * literal `<br />` per line of `bodyText`, in the same order — at the same
 * line `stripQuotedHistory` would cut `bodyText` at. Falls back to "nothing
 * quoted" when there is no `bodyText` to find that line in.
 */
export function splitPlainTextMessageHtml(bodyText: string, bodyHtml: string): QuotedHistorySplit {
  if (!bodyText) return { visible: bodyHtml, quoted: null };
  const lines = bodyText.split(/\r?\n/);
  const cut = findQuoteCutLine(lines);
  if (cut >= lines.length) return { visible: bodyHtml, quoted: null };
  const segments = bodyHtml.split("<br />");
  const quoted = segments.slice(cut).join("<br />").trim();
  if (!quoted) return { visible: bodyHtml, quoted: null };
  return { visible: segments.slice(0, cut).join("<br />"), quoted };
}

/**
 * The one entry point the Mail App's reading pane calls (`MessageBody.tsx`):
 * picks the plain-text or native-HTML rule by `bodyIsPlainText`, the same
 * flag the Width decision (#98) already reads to choose a message's column
 * width.
 */
export function splitMessageQuotedHistory(message: {
  bodyHtml: string | null;
  bodyText: string | null;
  bodyIsPlainText: boolean;
}): QuotedHistorySplit {
  if (!message.bodyHtml) return { visible: "", quoted: null };
  return message.bodyIsPlainText
    ? splitPlainTextMessageHtml(message.bodyText ?? "", message.bodyHtml)
    : splitQuotedHtml(message.bodyHtml);
}
