import { and, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, labels } from "../db/schema.js";
import type { FolderRole } from "./folders.js";

/**
 * `POST /search`'s query (#50, ADR-0016): the Candidate Window, ranking, and
 * dedup. `routes/search.ts` is the thin HTTP layer around this — parsing the
 * request, resolving Mail Account ownership, and turning the ranked rows
 * back into wire shapes; everything that decides *which* messages match and
 * *in what order* lives here.
 */

/** The newest N matching messages actually ranked, per ADR-0016 — the bar this number is measured against is `docs/research/0007`. */
export const CANDIDATE_WINDOW = 500;
/** One page of ranked, thread-deduped results. */
export const PAGE_SIZE = 50;
/** ADR-0016: "the trailing token gets `:*` prefix treatment only at ≥3 characters". */
const MIN_PREFIX_LENGTH = 3;

const FOLDER_ROLES = new Set<FolderRole>([
  "inbox",
  "archive",
  "drafts",
  "sent",
  "junk",
  "trash",
  "flagged",
  "all",
]);

export interface SearchFilters {
  mailAccountId: string;
  text: string;
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  folder?: string;
  label?: string;
  /** Calendar dates (`YYYY-MM-DD`), already validated by `searchRequestSchema`. */
  after?: string;
  before?: string;
  cursor?: string;
}

export interface SearchResultRow {
  threadId: string;
  matchedMessageId: string;
  folderId: string;
  headline: string | null;
}

export interface SearchQueryResult {
  rows: SearchResultRow[];
  /** Pass back as the next request's `cursor`; `null` once the Candidate Window is exhausted. */
  cursor: string | null;
}

const NO_RESULTS: SearchQueryResult = { rows: [], cursor: null };

/**
 * Runs one page of `POST /search`. `filters.folder`/`filters.label` naming
 * something that does not exist for this Mail Account is answered with an
 * empty result rather than an error — a stale scope chip or a mistyped
 * label name searches nothing, the same tolerance a folder-scoped search
 * already has for "this account has no such folder yet".
 */
export async function runSearch(db: Db, filters: SearchFilters): Promise<SearchQueryResult> {
  const conditions: SQL[] = [sql`ms.mail_account_id = ${filters.mailAccountId}`];

  const tsQuery = buildTsQuery(filters.text);
  if (tsQuery) conditions.push(sql`ms.doc @@ ${tsQuery}`);

  if (filters.folder) {
    const folderIds = await resolveFolderIds(db, filters.mailAccountId, filters.folder);
    if (folderIds.length === 0) return NO_RESULTS;
    // Drizzle's `sql` template spreads a plain JS array into a
    // comma-separated parameter list (`(${arr})` → `($1, $2, ...)`), which is
    // exactly `in (...)`/`not in (...)` shape — not a single Postgres array
    // parameter, so `= ANY(${arr})` sends a bare scalar and breaks on
    // anything but a one-element array.
    conditions.push(sql`ms.folder_id in (${folderIds})`);
  } else {
    // ADR-0016's default scope: every folder but Trash and Junk.
    const excludedFolderIds = await resolveExcludedFolderIds(db, filters.mailAccountId);
    if (excludedFolderIds.length > 0)
      conditions.push(sql`ms.folder_id not in (${excludedFolderIds})`);
  }

  if (filters.label) {
    const labelId = await resolveLabelId(db, filters.mailAccountId, filters.label);
    if (!labelId) return NO_RESULTS;
    // Filtered off the Sync Backend's own label join, not the Search Index
    // (#50's own resolution comment) — `threads.label_ids` is where Labels
    // live, `message_search` gains no column for this.
    conditions.push(
      sql`exists (select 1 from threads t2 where t2.id = ms.thread_id and t2.label_ids @> ARRAY[${labelId}])`,
    );
  }

  if (filters.after) conditions.push(sql`ms.sent_at >= ${filters.after}::timestamptz`);
  // Inclusive on the named calendar day (search.ts's `before` doc comment,
  // query-parser.ts's own copy of that contract, and the Client prefilter's
  // `withinDateRange` all agree on this) — `< before + 1 day` rather than
  // `< before`, which would exclude the named day entirely.
  if (filters.before)
    conditions.push(sql`ms.sent_at < (${filters.before}::timestamptz + interval '1 day')`);

  if (filters.cursor) {
    const cursorDate = new Date(filters.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conditions.push(sql`ms.sent_at < ${cursorDate.toISOString()}::timestamptz`);
    }
  }

  // `from:`/`to:`/`has:attachment` need columns `message_search` doesn't
  // carry — joined in only when actually asked for, so the common
  // free-text-only query keeps the exact shape `bench:shapes` measures.
  const needsMessageJoin = Boolean(filters.from || filters.to || filters.hasAttachment);
  if (filters.from) {
    const needle = likeNeedle(filters.from);
    conditions.push(sql`(fm.from_name ilike ${needle} or fm.from_address ilike ${needle})`);
  }
  if (filters.to) {
    const needle = likeNeedle(filters.to);
    conditions.push(sql`
      exists (
        select 1 from jsonb_array_elements(fm.to_addresses || fm.cc_addresses) e
        where (e->>'address') ilike ${needle} or (e->>'name') ilike ${needle}
      )
    `);
  }
  if (filters.hasAttachment) conditions.push(sql`fm.has_attachments = true`);

  const whereSql = sql.join(conditions, sql` and `);
  const candJoinSql = needsMessageJoin ? sql`join messages fm on fm.id = ms.message_id` : sql``;
  const rankSql = tsQuery ? sql`ts_rank_cd(doc, ${tsQuery})` : sql`1::real`;

  // `ts_headline` needs the matched message's body — joined only for the
  // (at most 50) winning rows, never the whole Candidate Window, and only
  // when there is a tsquery to highlight against (ADR-0016: "+1-3ms over
  // the whole page — the cheap part").
  const headlineJoinSql = tsQuery
    ? sql`
        join messages hm on hm.id = t.message_id
        cross join lateral (
          select ts_headline(
            'simple', coalesce(hm.body_text, ''), ${tsQuery},
            'MaxFragments=1,MinWords=8,MaxWords=20,StartSel=' || chr(1) || ',StopSel=' || chr(2)
          ) as headline_raw
        ) h
      `
    : sql``;
  // A subject-only match (or a body still behind the Index Watermark)
  // produces a `ts_headline` with no highlighted span at all — `chr(1)`
  // never appears — and that is reported as `null` so the Client keeps the
  // Thread's own Snippet rather than showing a highlight-free fragment.
  const headlineExpr = tsQuery
    ? sql`case when position(chr(1) in h.headline_raw) > 0 then h.headline_raw else null end`
    : sql`null::text`;

  const [row] = await db.execute<{
    results: {
      threadId: string;
      matchedMessageId: string;
      folderId: string;
      headline: string | null;
    }[];
    candidate_count: number;
    oldest_candidate_sent_at: string | null;
  }>(sql`
    with cand as (
      select ms.thread_id, ms.message_id, ms.sent_at, ms.doc
      from message_search ms
      ${candJoinSql}
      where ${whereSql}
      order by ms.sent_at desc
      limit ${CANDIDATE_WINDOW}
    ),
    hits as (
      select distinct on (thread_id) thread_id, message_id, sent_at, ${rankSql} as rank
      from cand
      order by thread_id, ${rankSql} desc, sent_at desc
    ),
    top as (
      select thread_id, message_id,
        rank * exp(-extract(epoch from (now() - sent_at)) / (86400 * 365.0)) as score
      from hits
      order by score desc, thread_id desc
      limit ${PAGE_SIZE}
    )
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'threadId', t.thread_id,
            'matchedMessageId', t.message_id,
            'folderId', ms2.folder_id,
            'headline', ${headlineExpr}
          )
          order by t.score desc, t.thread_id desc
        ),
        '[]'::jsonb
      ) as results,
      (select count(*) from cand)::int as candidate_count,
      (select min(sent_at) from cand) as oldest_candidate_sent_at
    from top t
    join message_search ms2 on ms2.message_id = t.message_id
    ${headlineJoinSql}
  `);

  if (!row) return NO_RESULTS;

  // The window came back full — there may be older matches still to page
  // to on "load older". Fewer than a full window means every match this
  // account has (for these filters) is already accounted for.
  const cursor =
    row.candidate_count >= CANDIDATE_WINDOW && row.oldest_candidate_sent_at
      ? new Date(row.oldest_candidate_sent_at).toISOString()
      : null;

  return { rows: row.results, cursor };
}

async function resolveFolderIds(db: Db, mailAccountId: string, token: string): Promise<string[]> {
  const normalized = token.trim().toLowerCase();
  if (FOLDER_ROLES.has(normalized as FolderRole)) {
    const byRole = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(eq(folders.mailAccountId, mailAccountId), eq(folders.role, normalized as FolderRole)),
      );
    if (byRole.length > 0) return byRole.map((row) => row.id);
  }
  const byName = await db
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        eq(folders.mailAccountId, mailAccountId),
        or(ilike(folders.name, token), ilike(folders.path, token)),
      ),
    );
  return byName.map((row) => row.id);
}

async function resolveExcludedFolderIds(db: Db, mailAccountId: string): Promise<string[]> {
  const rows = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.mailAccountId, mailAccountId), inArray(folders.role, ["trash", "junk"])));
  return rows.map((row) => row.id);
}

async function resolveLabelId(db: Db, mailAccountId: string, name: string): Promise<string | null> {
  const normalized = name.trim().toLowerCase();
  const [row] = await db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.mailAccountId, mailAccountId),
        eq(sql<string>`lower(${labels.name})`, normalized),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Same convention as `routes/correspondents.ts#escapeLike` — a literal `%`/`_` in a query never matches unrelated rows. */
function likeNeedle(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Tokenizes the Client's free-text remainder into an AND-chained `tsquery`:
 * every token exact-match except the trailing one, which gets `:*` prefix
 * treatment once it reaches 3 characters (ADR-0016). Tokens are sanitized to
 * `[a-z0-9]+` before being handed to `to_tsquery` — the only characters that
 * pattern can produce are ones `to_tsquery`'s own syntax (`&`, `|`, `!`,
 * `<->`, parentheses) never treats specially, so no user input ever reaches
 * `to_tsquery` unescaped. A token that sanitizes to nothing (pure
 * punctuation) is dropped rather than breaking the chain.
 */
function buildTsQuery(text: string): SQL | null {
  const tokens = text
    .trim()
    .split(/\s+/)
    .map((raw) => raw.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;

  let query: SQL | null = null;
  tokens.forEach((token, index) => {
    const isLast = index === tokens.length - 1;
    const pattern = isLast && token.length >= MIN_PREFIX_LENGTH ? `${token}:*` : token;
    const part = sql`to_tsquery('simple', ${pattern})`;
    query = query ? sql`${query} && ${part}` : part;
  });
  return query;
}
