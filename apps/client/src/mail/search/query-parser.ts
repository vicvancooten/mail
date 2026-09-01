/**
 * The search query language (#51, `docs/search-ux-spec.md` §The query
 * language, ADR-0016). **The raw text is the source of truth** — this is
 * the only place `from:`/`to:`/`in:`/`before:`/`after:`/`label:`/
 * `has:attachment` syntax is ever read, and it is a pure `string -> filter
 * fields` function: no chip, toggle or seed holds state beside the string,
 * they all read it (via `parseSearchQuery`) or edit it (via
 * `setQueryOperator`/`toggleTrashJunkOperator`) and nothing else.
 *
 * The Sync Backend never re-parses a query string (ADR-0016 §Wire shape) —
 * `ParsedSearchQuery`'s fields line up with `SearchRequest`
 * (`@mail/shared`'s `search.ts`) one for one, so building a request is just
 * `{ mailAccountId, ...parseSearchQuery(text) }` plus whatever scope the
 * seed contributes (`scope.ts`).
 */

export interface ParsedSearchQuery {
  /** The free-text remainder, operators stripped, original token order and spacing collapsed to single spaces. */
  text: string;
  /** `from:` — display name or address. */
  from?: string;
  /** `to:` — display name or address, includes Cc per the Sync Backend's own matching. */
  to?: string;
  /** `has:attachment` */
  hasAttachment?: boolean;
  /** `in:` — a folder role or custom folder name, exactly as typed (matching is case-insensitive server-side). */
  folder?: string;
  /** `label:` — a Label name, quotes stripped when the User quoted a multi-word name. */
  label?: string;
  /** `after:` — inclusive lower bound, exactly as typed. */
  after?: string;
  /** `before:` — inclusive upper bound, exactly as typed. */
  before?: string;
}

/** A closed set (`docs/search-ux-spec.md` §Operators): anything else is free text, `-` and all. */
const KNOWN_OPERATORS = new Set(["from", "to", "has", "in", "before", "after", "label"]);

/**
 * Quote-aware whitespace split: `label:"to read"` stays one token so the
 * quoted Label name survives. General quoted-phrase search is deferred
 * (spec: "a plausible later upgrade, but not PoC") — this tokenizer exists
 * only to keep a quoted operator *value* intact, not to introduce phrase
 * matching for free text.
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && /\s/.test(raw[i] as string)) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !/\s/.test(raw[i] as string)) {
      if (raw[i] === '"') {
        i++;
        while (i < n && raw[i] !== '"') i++;
        if (i < n) i++; // consume the closing quote
      } else {
        i++;
      }
    }
    tokens.push(raw.slice(start, i));
  }
  return tokens;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * `string -> filter fields`, per the module doc comment. Implicit AND
 * between every recognized operator and the free-text remainder — there is
 * no boolean grammar to parse (spec: "the recovery gesture in a mailbox is
 * 'type another word', not 'restructure the boolean'").
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = { text: "" };
  const freeText: string[] = [];

  for (const rawToken of tokenize(raw)) {
    const negated = rawToken.startsWith("-") && rawToken.length > 1;
    const token = negated ? rawToken.slice(1) : rawToken;
    const colonIndex = token.indexOf(":");

    if (colonIndex <= 0) {
      freeText.push(rawToken);
      continue;
    }

    const key = token.slice(0, colonIndex).toLowerCase();
    const rawValue = token.slice(colonIndex + 1);

    // Unknown `foo:` prefixes fall through to free text — "nobody loses a
    // search to a typo'd operator" (spec).
    if (!KNOWN_OPERATORS.has(key)) {
      freeText.push(rawToken);
      continue;
    }

    const value = stripQuotes(rawValue);
    if (value.length === 0) {
      // `from:` with nothing after it isn't a usable filter either.
      freeText.push(rawToken);
      continue;
    }

    if (negated) {
      // "`-` negation on operators only" (spec) — recognized grammar, so it
      // never falls through to free text, but the wire contract (ADR-0016's
      // `SearchRequest`) has no exclude-field for any of these: honoring a
      // negation means "this filter does not apply", never "apply its
      // opposite". The one operator pair this actually changes anything
      // for is `-in:trash`/`-in:junk`, which is exactly the Trash & Junk
      // toggle's own "remove" direction (`toggleTrashJunkOperator` below).
      continue;
    }

    switch (key) {
      case "from":
        result.from = value;
        break;
      case "to":
        result.to = value;
        break;
      case "has":
        if (value.toLowerCase() === "attachment") result.hasAttachment = true;
        else freeText.push(rawToken); // only `has:attachment` is defined
        break;
      case "in":
        result.folder = value;
        break;
      case "label":
        result.label = value;
        break;
      case "before":
        result.before = value;
        break;
      case "after":
        result.after = value;
        break;
    }
  }

  result.text = freeText.join(" ");
  return result;
}

/**
 * Chips edit the string, never state beside it (spec §The chip row).
 * Removes every existing `key:` token (negated or not) and, when `value` is
 * non-null, appends one fresh `key:value` token at the end. A value with
 * whitespace is double-quoted — the one typed form `label:"to read"` needs.
 */
export function setQueryOperator(raw: string, key: string, value: string | null): string {
  const prefix = `${key.toLowerCase()}:`;
  const kept = tokenize(raw).filter((token) => {
    const bare = token.startsWith("-") ? token.slice(1) : token;
    return !bare.toLowerCase().startsWith(prefix);
  });
  if (value !== null && value.length > 0) {
    const quoted = /\s/.test(value) ? `"${value}"` : value;
    kept.push(`${key}:${quoted}`);
  }
  return kept.join(" ");
}

/**
 * The Trash & Junk toggle (spec §The chip row): "writes and removes
 * `in:trash` / `in:junk`". The wire's `folder` field only ever holds one
 * value, so this toggles between "no `in:` at all" (the ADR-0016 default,
 * every folder but Trash and Junk) and `in:trash` — the concrete escape
 * from that default ("I definitely deleted it" is the named top-five
 * search). Turning the toggle off removes whichever of `in:trash`/`in:junk`
 * is present, so a query seeded or typed into `in:junk` also clears via the
 * same control.
 */
export function toggleTrashJunkOperator(raw: string): string {
  const current = parseSearchQuery(raw).folder?.toLowerCase();
  if (current === "trash" || current === "junk") return setQueryOperator(raw, "in", null);
  return setQueryOperator(raw, "in", "trash");
}

/**
 * A small English+Dutch stopword list (ADR-0016 §The query: "the Client's
 * query parser strips a small English+Dutch stopword list before sending —
 * `simple` ships no stopword list, and fixing that server-side would mean a
 * custom Postgres image"). Deliberately short — this is a floor-noise
 * filter, not a linguistic feature, and "a query of *only* stopwords is run
 * as-is" is handled by `stripStopwords` itself never emptying a query that
 * was nothing but stopwords to begin with.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "de",
  "een",
  "en",
  "het",
  "op",
  "van",
  "voor",
]);

/** The free-text remainder sent to the Sync Backend — never the client-side prefilter's, which matches raw substrings. */
export function stripStopwords(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
  return (kept.length > 0 ? kept : words).join(" ");
}

/**
 * ADR-0016's floor: "Minimum query length is 3 characters... below it,
 * nothing renders rather than something bad." A structured filter (any
 * operator) always clears the floor on its own — `from:vic` with nothing
 * else typed is a complete, searchable query (search.ts's own doc comment:
 * "`text` ... may be empty when the User searched on structured filters
 * alone").
 */
export function meetsSearchFloor(parsed: ParsedSearchQuery): boolean {
  if (parsed.text.trim().length >= 3) return true;
  return (
    parsed.from !== undefined ||
    parsed.to !== undefined ||
    parsed.hasAttachment === true ||
    parsed.folder !== undefined ||
    parsed.label !== undefined ||
    parsed.after !== undefined ||
    parsed.before !== undefined
  );
}
