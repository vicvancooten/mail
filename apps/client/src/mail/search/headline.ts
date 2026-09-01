/**
 * `SearchResult.headline`'s own doc comment (`@mail/shared`'s `search.ts`):
 * matched spans are wrapped in a pair of ASCII control-character markers
 * (start `\x01`, end `\x02`) rather than an HTML tag, "deliberately: this
 * text has never been through `sync/sanitize.ts`... The Client turns the
 * markers into emphasis itself, never `dangerouslySetInnerHTML`."
 *
 * This is that turn: a plain string in, a list of plain-text/matched
 * segments out, for `ThreadRow` to render as `<mark>` — every byte still
 * goes through React's normal text rendering, none of it ever becomes HTML.
 */

const START = "\x01";
const END = "\x02";

export interface HeadlineSegment {
  text: string;
  matched: boolean;
  /** The segment's starting offset in the original headline — a stable React key, unlike its array index. */
  offset: number;
}

export function parseHeadline(headline: string): HeadlineSegment[] {
  const segments: HeadlineSegment[] = [];
  let rest = headline;
  let consumed = 0;
  while (rest.length > 0) {
    const start = rest.indexOf(START);
    if (start === -1) {
      segments.push({ text: rest, matched: false, offset: consumed });
      break;
    }
    if (start > 0) segments.push({ text: rest.slice(0, start), matched: false, offset: consumed });
    const end = rest.indexOf(END, start + 1);
    if (end === -1) {
      // An unterminated marker — treat the rest as plain text rather than swallowing it.
      segments.push({ text: rest.slice(start + 1), matched: false, offset: consumed + start + 1 });
      break;
    }
    segments.push({
      text: rest.slice(start + 1, end),
      matched: true,
      offset: consumed + start + 1,
    });
    consumed += end + 1;
    rest = rest.slice(end + 1);
  }
  return segments;
}
