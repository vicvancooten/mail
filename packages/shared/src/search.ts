import { z } from "zod";
import { indexWatermarkSchema } from "./mail-accounts.js";
import { threadSchema } from "./sync.js";

/**
 * `POST /search`'s wire contract (#50, ADR-0016, `docs/search-ux-spec.md`).
 * Deliberately outside ADR-0011's delta protocol — a stateless query is not
 * a synced collection, so this is a plain request/response, not a
 * `{collection → stateToken}` entry.
 *
 * **Structured filter fields, never a query string**: the Client's own
 * parser (`docs/search-ux-spec.md` §The query language) is the only place
 * `from:`/`to:`/`in:`/`before:`/`after:`/`label:`/`has:attachment` syntax is
 * ever read — this backend never re-parses one. `text` is whatever free-text
 * remainder is left after the Client strips operators and a small
 * English+Dutch stopword list; it is tokenized into a `tsquery` server-side
 * (ADR-0016: "the trailing token gets `:*` prefix treatment only at ≥3
 * characters, earlier tokens are exact-match AND"), and may be empty when
 * the User searched on structured filters alone (e.g. `from:vic` with
 * nothing else typed).
 */
export const searchRequestSchema = z.object({
  mailAccountId: z.string(),
  /** The free-text remainder, already operator- and stopword-stripped by the Client. May be `""`. */
  text: z.string().default(""),
  /** `from:` — matches display name or address, per the Search Index's participant/address-part weights. */
  from: z.string().optional(),
  /** `to:` — includes `Cc`, same matching as `from`. */
  to: z.string().optional(),
  /** `has:attachment` */
  hasAttachment: z.boolean().optional(),
  /**
   * `in:` — a folder role name (`inbox`, `archive`, `trash`, `junk`, ...) or
   * a literal folder name/path for a custom folder, matched case-insensitively.
   * Absent means the ADR-0016 default: every folder but Trash and Junk. This
   * is also the escape from that default — `in:trash`/`in:junk` reach held
   * mail that Block (ADR-0008) moved there for real.
   */
  folder: z.string().optional(),
  /**
   * `label:` — matched case-insensitively on the Label's name (comment on
   * #50: "filters off the Sync Backend's own label join, not the Search
   * Index — `message_search` gains nothing").
   */
  label: z.string().optional(),
  /** `after:` — inclusive lower bound on `sentAt`, calendar date. */
  after: z.iso.date().optional(),
  /** `before:` — inclusive upper bound on `sentAt`, calendar date. */
  before: z.iso.date().optional(),
  /**
   * The Candidate Window cursor from a previous response's `cursor` — "load
   * older" pages the window back, keyset on `sentAt` rather than score (a
   * score keyset is unstable under concurrent new mail). Absent for the
   * first page.
   */
  cursor: z.string().optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** The folder pill (`docs/search-ux-spec.md` §The row): omitted client-side for an Inbox result. */
export const searchResultFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z
    .enum(["inbox", "archive", "drafts", "sent", "junk", "trash", "flagged", "all"])
    .nullable(),
});
export type SearchResultFolder = z.infer<typeof searchResultFolderSchema>;

/**
 * One ranked, thread-deduped result row (ADR-0016: "the same `Thread`
 * list-row projection ADR-0011 already defines"). `headline` is the
 * `ts_headline` fragment over the matched message's body, `null` when the
 * match was subject-only (or the body is still behind the Index Watermark)
 * — the Client keeps the Thread's own Snippet in that case rather than
 * showing a broken-looking blank.
 *
 * Matched spans are wrapped in a pair of ASCII control-character markers
 * (start 0x01, end 0x02) rather than an HTML tag, deliberately: this text
 * has never been through `sync/sanitize.ts`, and marking it up with a real
 * `<mark>` would hand the Client sender-controlled bytes to render as HTML.
 * The Client turns the markers into emphasis itself, never
 * `dangerouslySetInnerHTML`.
 *
 * Gatekeeper's `Held`/`Blocked` badges (`docs/search-ux-spec.md` §The row)
 * have no field here yet — Gatekeeper (#12) is sequenced last in the build
 * order and ships no verdict state this projection could read.
 */
export const searchResultSchema = z.object({
  thread: threadSchema,
  matchedMessageId: z.string(),
  headline: z.string().nullable(),
  folder: searchResultFolderSchema,
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  /** Pass back as the next request's `cursor` for "load older"; `null` once the Candidate Window is exhausted. */
  cursor: z.string().nullable(),
  /** This Mail Account's Index Watermark — same shape `MailAccount.indexWatermark` carries. */
  indexWatermark: indexWatermarkSchema,
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
