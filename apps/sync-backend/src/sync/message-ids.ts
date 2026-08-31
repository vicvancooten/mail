/**
 * `Message-ID` handling for threading (#34).
 *
 * Every id that reaches the store goes through `normalizeMessageId` first,
 * so `thread_message_ids` only ever holds one spelling of a given id: the
 * addr-spec with its angle brackets, surrounding whitespace and any CFWS
 * comments removed. Case is left alone — RFC 5322's `id-left` is a local
 * part and case-sensitive in principle, and lowercasing it would merge two
 * genuinely different ids on the (rare) server that mints case-varying ones.
 */

/** Longer than any legitimate id; a header this big is malformed or hostile. */
const MAX_MESSAGE_ID_LENGTH = 998;

/** Caps a pathological `References` chain — a real one is tens of ids, not thousands. */
const MAX_REFERENCES = 100;

/**
 * Strips the angle brackets and whitespace from one `Message-ID`-shaped
 * value. Returns `null` for anything empty, oversized, or with no `@` — a
 * value that cannot identify a message is worse than no value at all here,
 * because storing it would let two unrelated messages collide on it.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_ID_LENGTH) return null;
  if (!trimmed.includes("@")) return null;
  if (/[\s<>]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parses a raw `References` header body into normalized ids, oldest-first
 * and de-duplicated.
 *
 * Real headers are folded across lines, sometimes comma-separated, and
 * regularly carry junk between the ids, so this scans for bracketed tokens
 * rather than splitting on whitespace. A header with no brackets at all
 * (a few clients emit bare ids) falls back to whitespace splitting.
 */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const bracketed = raw.match(/<[^<>]+>/g);
  const tokens = bracketed ?? raw.split(/[\s,]+/);
  const seen = new Set<string>();
  for (const token of tokens) {
    const id = normalizeMessageId(token);
    if (id) seen.add(id);
    if (seen.size >= MAX_REFERENCES) break;
  }
  return [...seen];
}

/**
 * Pulls the `References` header out of the raw header block ImapFlow returns
 * for `fetch(..., { headers: ["references"] })`. The block is a small
 * RFC 5322 header section, so unfolding is "a continuation line starts with
 * whitespace"; there can legitimately be more than one `References:` line in
 * broken mail, and both are read.
 */
export function extractReferencesHeader(headerBlock: Buffer | undefined): string[] {
  if (!headerBlock || headerBlock.length === 0) return [];
  const unfolded = headerBlock.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const values: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^references\s*:(.*)$/i.exec(line);
    if (match?.[1]) values.push(match[1]);
  }
  return parseReferences(values.join(" "));
}

/**
 * The ids a message's Thread is resolved against, oldest ancestor first and
 * the message's own id last: its `References` chain, then `In-Reply-To` (kept
 * separate because plenty of clients send one without the other), then
 * itself. Order matters — `threading.ts` picks the surviving Thread by age,
 * and this is the order the chain is registered in.
 */
export function threadingIdsFor(input: {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}): string[] {
  const ids = new Set<string>(input.references);
  if (input.inReplyTo) ids.add(input.inReplyTo);
  if (input.messageId) ids.add(input.messageId);
  return [...ids];
}
