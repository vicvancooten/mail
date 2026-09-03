import { and, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { folders, labels } from "../db/schema.js";
import type { FolderRole } from "./folders.js";

/**
 * `POST /search`'s query (#50, #68, ADR-0016): the Account Scope, the
 * per-account Candidate Window, ranking, and dedup. `routes/search.ts` is the
 * thin HTTP layer around this — parsing the request, resolving Mail Account
 * ownership, and turning the ranked rows back into wire shapes; everything
 * that decides *which* messages match and *in what order* lives here.
 */

/** The newest N matching messages actually ranked *per in-scope Mail Account* (#68, ADR-0016) — the bar this number is measured against is `docs/research/0007`. */
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
  /**
   * The Account Scope (#68): every Mail Account this search runs over.
   * Always at least one id. Each contributes its own Candidate Window —
   * never one shared window across the Scope, which would let a chatty
   * account crowd a quiet one out of its own results entirely.
   */
  mailAccountIds: string[];
  text: string;
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  folder?: string;
  label?: string;
  /** Calendar dates (`YYYY-MM-DD`), already validated by `searchRequestSchema`. */
  after?: string;
  before?: string;
  /** Opaque — see `encodeCursor`/`decodeCursor` below. */
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
  /** Pass back as the next request's `cursor`; `null` once every in-scope account's Candidate Window is exhausted. */
  cursor: string | null;
}

const NO_RESULTS: SearchQueryResult = { rows: [], cursor: null };

const CURSOR_TOKEN_VERSION = 1;

/**
 * `cursor`'s decoded shape, one entry per Mail Account the *previous* page
 * knew about: a `sentAt` boundary string means "load older" should resume
 * strictly before it, `null` means that account was already exhausted (every
 * match already returned) and stays dropped from every later page. An
 * account absent from the map entirely was never part of that earlier page's
 * Scope at all — the Client widened the Scope mid-pagination — and is
 * treated as a brand-new page-1 account rather than silently skipped, which
 * is what a plain "absent = exhausted" scheme would do to it.
 */
type CursorWindows = Record<string, string | null>;

interface CursorTokenPayload {
  v: number;
  w: CursorWindows;
}

function encodeCursor(windows: CursorWindows): string {
  const payload: CursorTokenPayload = { v: CURSOR_TOKEN_VERSION, w: windows };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Same "not recognized and not trusted" posture as `sync/sync-tokens.ts`:
 * malformed base64/JSON, a wrong version, or a non-object `w` all decode to
 * `null` — which callers below treat as "no cursor", i.e. every in-scope
 * account starts its window over from the newest matching message. A search
 * cursor is a short-lived pagination handle within one query session, never
 * a value round-tripped across a deploy, so there is no legacy format to
 * stay compatible with.
 */
function decodeCursor(token: string): CursorWindows | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;
  const payload = decoded as Partial<CursorTokenPayload>;
  if (payload.v !== CURSOR_TOKEN_VERSION) return null;
  if (typeof payload.w !== "object" || payload.w === null) return null;
  for (const value of Object.values(payload.w)) {
    if (typeof value !== "string" && value !== null) return null;
  }
  return payload.w as CursorWindows;
}

/**
 * Runs one page of `POST /search` across the Account Scope. `filters.folder`
 * or `filters.label` naming something that does not exist for one in-scope
 * account is answered by that account contributing nothing to this page,
 * rather than failing the whole Scope — the same tolerance a single-account
 * search already has for "this account has no such folder yet", generalized
 * per account rather than all-or-nothing.
 */
export async function runSearch(db: Db, filters: SearchFilters): Promise<SearchQueryResult> {
  const tsQuery = buildTsQuery(filters.text);
  const cursorWindows = filters.cursor ? decodeCursor(filters.cursor) : null;
  // Drop only accounts the cursor explicitly marked exhausted (`null`) — one
  // it's silent about (never part of the earlier page's Scope) still runs as
  // a fresh page-1 account, and one it names with a boundary keeps paging.
  const scopedAccountIds = cursorWindows
    ? filters.mailAccountIds.filter((id) => cursorWindows[id] !== null)
    : filters.mailAccountIds;

  // `from:`/`to:`/`has:attachment` need columns `message_search` doesn't
  // carry — joined in only when actually asked for, so the common
  // free-text-only query keeps the exact shape `bench:shapes` measures.
  const needsMessageJoin = Boolean(filters.from || filters.to || filters.hasAttachment);
  const candJoinSql = needsMessageJoin ? sql`join messages fm on fm.id = ms.message_id` : sql``;
  const sharedConditions = buildSharedConditions(filters);

  const perAccountCandidates: SQL[] = [];
  for (const mailAccountId of scopedAccountIds) {
    const conditions: SQL[] = [sql`ms.mail_account_id = ${mailAccountId}`, ...sharedConditions];
    if (tsQuery) conditions.push(sql`ms.doc @@ ${tsQuery}`);

    if (filters.folder) {
      const folderIds = await resolveFolderIds(db, mailAccountId, filters.folder);
      if (folderIds.length === 0) continue;
      // Drizzle's `sql` template spreads a plain JS array into a
      // comma-separated parameter list (`(${arr})` → `($1, $2, ...)`), which
      // is exactly `in (...)`/`not in (...)` shape — not a single Postgres
      // array parameter, so `= ANY(${arr})` sends a bare scalar and breaks
      // on anything but a one-element array.
      conditions.push(sql`ms.folder_id in (${folderIds})`);
    } else {
      // ADR-0016's default scope: every folder but Trash and Junk.
      const excludedFolderIds = await resolveExcludedFolderIds(db, mailAccountId);
      if (excludedFolderIds.length > 0)
        conditions.push(sql`ms.folder_id not in (${excludedFolderIds})`);
    }

    if (filters.label) {
      const labelId = await resolveLabelId(db, mailAccountId, filters.label);
      if (!labelId) continue;
      // Filtered off the Sync Backend's own label join, not the Search Index
      // (#50's own resolution comment) — `threads.label_ids` is where Labels
      // live, `message_search` gains no column for this.
      conditions.push(
        sql`exists (select 1 from threads t2 where t2.id = ms.thread_id and t2.label_ids @> ARRAY[${labelId}])`,
      );
    }

    const boundary = cursorWindows?.[mailAccountId];
    if (boundary) conditions.push(sql`ms.sent_at < ${boundary}::timestamptz`);

    const whereSql = sql.join(conditions, sql` and `);
    perAccountCandidates.push(sql`
      (select ms.thread_id, ms.message_id, ms.sent_at, ms.doc, ms.mail_account_id
       from message_search ms
       ${candJoinSql}
       where ${whereSql}
       order by ms.sent_at desc
       limit ${CANDIDATE_WINDOW})
    `);
  }

  if (perAccountCandidates.length === 0) return NO_RESULTS;
  const candSql = sql.join(perAccountCandidates, sql` union all `);

  const rankSql = tsQuery ? sql`ts_rank_cd(doc, ${tsQuery})` : sql`1::real`;

  // `ts_headline` needs the matched message's body — joined only for the
  // (at most 50) winning rows, never any account's whole Candidate Window,
  // and only when there is a tsquery to highlight against (ADR-0016: "+1-3ms
  // over the whole page — the cheap part").
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
    candidates: { mailAccountId: string; count: number; oldestSentAt: string | null }[];
  }>(sql`
    with cand as (
      ${candSql}
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
      (
        select coalesce(
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
        )
        from top t
        join message_search ms2 on ms2.message_id = t.message_id
        ${headlineJoinSql}
      ) as results,
      (
        -- Per in-scope account, not merged: whether that account's own
        -- window came back full decides whether it still has more to page
        -- to (buildNextCursor below) — a merged total tells you nothing
        -- about which account it belongs to.
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'mailAccountId', g.mail_account_id,
              'count', g.candidate_count,
              'oldestSentAt', g.oldest_sent_at
            )
          ),
          '[]'::jsonb
        )
        from (
          select mail_account_id, count(*) as candidate_count, min(sent_at) as oldest_sent_at
          from cand
          group by mail_account_id
        ) g
      ) as candidates
  `);

  if (!row) return NO_RESULTS;

  return { rows: row.results, cursor: buildNextCursor(scopedAccountIds, row.candidates) };
}

/**
 * The window came back full for an account — there may be older matches of
 * *its own* still to page to on "load older", so it gets a boundary in the
 * next cursor. Fewer than a full window (including zero rows, which never
 * appears in `candidates` at all) means every match that account has is
 * already accounted for, so it is marked exhausted (`null`) rather than left
 * out — `runSearch` needs that to tell "exhausted" apart from "never part of
 * this cursor's Scope" on the next page (see `CursorWindows`). `null` when
 * every account is exhausted: nothing further exists to page to at all.
 */
function buildNextCursor(
  scopedAccountIds: string[],
  candidates: { mailAccountId: string; count: number; oldestSentAt: string | null }[],
): string | null {
  const byAccountId = new Map(candidates.map((candidate) => [candidate.mailAccountId, candidate]));
  const windows: CursorWindows = {};
  let anyContinuing = false;
  for (const mailAccountId of scopedAccountIds) {
    const candidate = byAccountId.get(mailAccountId);
    if (candidate && candidate.count >= CANDIDATE_WINDOW && candidate.oldestSentAt) {
      windows[mailAccountId] = new Date(candidate.oldestSentAt).toISOString();
      anyContinuing = true;
    } else {
      windows[mailAccountId] = null;
    }
  }
  return anyContinuing ? encodeCursor(windows) : null;
}

/** Conditions identical for every in-scope account — folder/label scope and the cursor boundary are the per-account exceptions, built in the caller's loop. */
function buildSharedConditions(filters: SearchFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.after) conditions.push(sql`ms.sent_at >= ${filters.after}::timestamptz`);
  // Inclusive on the named calendar day (search.ts's `before` doc comment,
  // query-parser.ts's own copy of that contract, and the Client prefilter's
  // `withinDateRange` all agree on this) — `< before + 1 day` rather than
  // `< before`, which would exclude the named day entirely.
  if (filters.before)
    conditions.push(sql`ms.sent_at < (${filters.before}::timestamptz + interval '1 day')`);

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
  return conditions;
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
