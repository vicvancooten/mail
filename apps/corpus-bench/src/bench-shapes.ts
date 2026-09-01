import type postgres from "postgres";
import { type LatencyStats, summarizeLatencies } from "./stats.js";

const SCHEMA = "corpus_bench";
const ITERATIONS_PER_QUERY = 20;

/**
 * The Candidate Window ADR-0016 specifies: rank the newest N matching
 * messages rather than every match in the archive.
 */
const CANDIDATE_WINDOW = 500;
const PAGE_SIZE = 50;

/**
 * Benchmarks the query shape search *actually* runs, which is not the shape
 * `bench-postgres.ts` measures. That one measures match-and-limit-50 — no
 * relevance ranking, no Thread deduplication — which was the right question
 * for wayfinder ticket #23 (does a client-side index survive this corpus?)
 * but stops the index scan early precisely because nothing has to be
 * ordered. Ranking a whole match set is unbounded work, and on this corpus
 * it breaks the 200ms bar in docs/poc-scope.md.
 *
 * So this bench compares four axes at once, which together are the evidence
 * for docs/adr/0016-search-runs-in-the-sync-backend-over-a-bounded-candidate-window.md:
 *
 * - uncapped ranked+deduped vs. capped to a Candidate Window
 * - the generated column on the wide messages table vs. a narrow
 *   `message_search` side table
 * - ordinary terms vs. the pathological cases (a two-character prefix, a
 *   term matching most of the corpus — `simple` ships no stopword list)
 * - with and without `ts_headline` fragments over the result page
 *
 * TODO(close-out review, 2026-09): "the query shape search *actually* runs"
 * above overstates it — every query here is hand-rolled SQL against this
 * package's own `corpus_bench.messages`/`message_search` tables, never a
 * call into `apps/sync-backend/src/sync/search-query.ts`'s shipped
 * `runSearch`. The "capped, side table [+ ts_headline]" cases track that
 * function's CTE shape closely but are not it — no `folders`/`labels`/
 * `threads` join, no cursor pagination, no `from`/`to`/`has:attachment`
 * join, a `folder text` column standing in for the real `folder_id` FK. So
 * #50's acceptance line ("bench:shapes bars hold on the real
 * implementation") is unverified by this file. Wiring this bench to call
 * `runSearch` directly would mean this package depending on
 * `@mail/sync-backend`'s Drizzle schema/migrations and regenerating the
 * 250k-message corpus to conform to the real product tables (uuid
 * mail_account_id, folders with roles, threads with label_ids, jsonb
 * address fields) in a database isolated from real dev data — this package
 * currently shares none of that (own `postgres` client, own schema, no
 * `@mail/sync-backend` dependency at all). That is a harness rearchitecture,
 * not a scoped fix; recommend it become its own #58 (performance
 * acceptance ticket) task rather than attempting it inside this fix batch.
 */
export interface ShapeQueryResult {
  label: string;
  stats: LatencyStats;
}

export interface SearchShapesResult {
  sideTableBytes: number;
  sideTableBuildMs: number;
  queries: ShapeQueryResult[];
}

async function timeQuery(run: () => Promise<unknown>, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return samples;
}

/**
 * Builds the ADR-0016 Search Index shape over the already-loaded corpus:
 * narrow rows, `simple` + unaccent (no stemming — this mailbox is Dutch and
 * English mixed), and address parts split into their own weight because
 * Postgres' parser treats `vic.van.cooten@a-insights.eu` as one atomic
 * token, so without them free-text sender search silently finds nothing.
 */
export async function ensureSearchIndexTable(sql: postgres.Sql): Promise<number> {
  const start = performance.now();
  await sql`CREATE EXTENSION IF NOT EXISTS unaccent`;
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.imm_unaccent(text) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
      AS $$ SELECT public.unaccent('public.unaccent', $1) $$;
  `);
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.addr_parts(text[]) RETURNS text
      LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT string_agg(p, ' ') FROM (
        SELECT unnest(regexp_split_to_array(lower(array_to_string($1, ' ')), '[^a-z0-9]+')) AS p
      ) s $$;
  `);
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION ${SCHEMA}.participants(from_addr text, tos text[]) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT coalesce(from_addr, '') || ' ' || coalesce(array_to_string(tos, ' '), '') $$;
  `);

  // The ADR-0016 document, expressed twice over the same corpus so the two
  // storage shapes are compared like for like: once as a generated column on
  // the wide messages table, once as the narrow side table.
  const doc = (t: string) => `
      setweight(to_tsvector('simple', ${SCHEMA}.imm_unaccent(coalesce(${t}.subject, ''))), 'A')
   || setweight(to_tsvector('simple', ${SCHEMA}.imm_unaccent(
        ${SCHEMA}.participants(${t}.from_address, ${t}.to_addresses))), 'B')
   || setweight(to_tsvector('simple', coalesce(
        ${SCHEMA}.addr_parts(array_append(${t}.to_addresses, ${t}.from_address)), '')), 'C')
   || setweight(to_tsvector('simple', ${SCHEMA}.imm_unaccent(coalesce(${t}.body_text, ''))), 'D')`;

  await sql.unsafe(`
    ALTER TABLE ${SCHEMA}.messages
      ADD COLUMN IF NOT EXISTS search_simple tsvector
      GENERATED ALWAYS AS (${doc("messages")}) STORED
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS messages_search_simple_idx
      ON ${SCHEMA}.messages USING GIN (search_simple)
  `);

  await sql.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.message_search`);
  await sql.unsafe(`
    CREATE TABLE ${SCHEMA}.message_search AS
    SELECT
      m.id AS message_id,
      m.mail_account_id,
      m.thread_id,
      m.folder,
      m.sent_at,
      1::smallint AS index_version,
      m.search_simple AS doc
    FROM ${SCHEMA}.messages m
  `);
  await sql.unsafe(`ALTER TABLE ${SCHEMA}.message_search ADD PRIMARY KEY (message_id)`);
  await sql.unsafe(
    `CREATE INDEX message_search_doc_idx ON ${SCHEMA}.message_search USING GIN (doc)`,
  );
  await sql.unsafe(
    `CREATE INDEX message_search_recency_idx ON ${SCHEMA}.message_search (mail_account_id, sent_at DESC)`,
  );
  await sql.unsafe(`ANALYZE ${SCHEMA}.message_search`);
  await sql.unsafe(`ANALYZE ${SCHEMA}.messages`);
  return performance.now() - start;
}

/** Ranked + Thread-deduped, over every match in the archive. */
function uncappedQuery(source: "messages" | "side", tsquery: string, headline: boolean) {
  const [table, id, doc] =
    source === "messages"
      ? [`${SCHEMA}.messages`, "id", "search_simple"]
      : [`${SCHEMA}.message_search`, "message_id", "doc"];
  return `
    WITH tq AS (SELECT ${tsquery} AS q),
    hits AS (
      SELECT DISTINCT ON (m.thread_id)
             m.thread_id, m.${id} AS message_id, m.sent_at,
             ts_rank_cd(m.${doc}, tq.q) AS rank
      FROM ${table} m, tq
      WHERE m.${doc} @@ tq.q AND m.mail_account_id = 1 AND m.folder <> 'Trash'
      ORDER BY m.thread_id, ts_rank_cd(m.${doc}, tq.q) DESC, m.sent_at DESC)
    SELECT thread_id, message_id${headline ? ", 1 AS frag" : ""},
           rank * exp(-extract(epoch FROM (now() - sent_at)) / (86400 * 365.0)) AS score
    FROM hits ORDER BY score DESC, thread_id DESC LIMIT ${PAGE_SIZE}`;
}

/** The ADR-0016 shape: rank only within the Candidate Window. */
function cappedQuery(source: "messages" | "side", tsquery: string, headline: boolean) {
  const [table, id, doc] =
    source === "messages"
      ? [`${SCHEMA}.messages`, "id", "search_simple"]
      : [`${SCHEMA}.message_search`, "message_id", "doc"];
  // ts_headline needs the body, which the side table deliberately doesn't
  // carry — the real backend joins it back from messages, so do the same.
  return `
    WITH tq AS (SELECT ${tsquery} AS q),
    cand AS (
      SELECT m.thread_id, m.${id} AS message_id, m.sent_at, m.${doc} AS doc
      FROM ${table} m, tq
      WHERE m.${doc} @@ tq.q AND m.mail_account_id = 1 AND m.folder <> 'Trash'
      ORDER BY m.sent_at DESC LIMIT ${CANDIDATE_WINDOW}),
    hits AS (
      SELECT DISTINCT ON (c.thread_id) c.thread_id, c.message_id, c.sent_at,
             ts_rank_cd(c.doc, tq.q) AS rank
      FROM cand c, tq ORDER BY c.thread_id, ts_rank_cd(c.doc, tq.q) DESC, c.sent_at DESC),
    top AS (
      SELECT thread_id, message_id,
             rank * exp(-extract(epoch FROM (now() - sent_at)) / (86400 * 365.0)) AS score
      FROM hits ORDER BY score DESC, thread_id DESC LIMIT ${PAGE_SIZE})
    SELECT t.thread_id, t.message_id, t.score${
      headline
        ? `,
           ts_headline('simple', m.body_text, (SELECT q FROM tq),
             'MaxFragments=1,MinWords=8,MaxWords=20,StartSel=<b>,StopSel=</b>') AS frag`
        : ""
    }
    FROM top t${headline ? ` JOIN ${SCHEMA}.messages m ON m.id = t.message_id` : ""}`;
}

interface ShapeCase {
  label: string;
  tsquery: string;
  /** Skipped uncapped when it is slow enough to make the run tedious. */
  uncapped: boolean;
}

/**
 * `evergreen` is a sender domain in this corpus and matches ~82% of it —
 * the stand-in for what a real mailbox hits when a stopword-free `simple`
 * configuration meets a common word ("the", "de", "van"). ADR-0016 handles
 * those by stripping stopwords in the Client's parser; the Candidate Window
 * is what catches whatever slips through.
 */
const CASES: ShapeCase[] = [
  {
    label: "term:quarterly (~3.4%)",
    tsquery: "plainto_tsquery('simple', 'quarterly')",
    uncapped: true,
  },
  {
    label: "term:quillfeather (0.01%)",
    tsquery: "plainto_tsquery('simple', 'quillfeather')",
    uncapped: true,
  },
  {
    label: "phrase:'quarterly budget'",
    tsquery: "plainto_tsquery('simple', 'quarterly budget')",
    uncapped: true,
  },
  {
    label: "prefix:quarte:* (type-ahead)",
    tsquery: "to_tsquery('simple', 'quarte:*')",
    uncapped: true,
  },
  {
    label: "prefix:qu:* (2 chars, pathological)",
    tsquery: "to_tsquery('simple', 'qu:*')",
    uncapped: false,
  },
  {
    label: "term:evergreen (~82%, stopword stand-in)",
    tsquery: "plainto_tsquery('simple', 'evergreen')",
    uncapped: false,
  },
  {
    label: "addr-part:kowalski0 (address local part)",
    tsquery: "plainto_tsquery('simple', 'kowalski0')",
    uncapped: true,
  },
];

export async function benchSearchShapes(sql: postgres.Sql): Promise<SearchShapesResult> {
  const sideTableBuildMs = await ensureSearchIndexTable(sql);
  const [{ size: sideTableBytes }] = await sql<[{ size: string }]>`
    SELECT pg_total_relation_size('corpus_bench.message_search')::text AS size
  `;

  const queries: ShapeQueryResult[] = [];
  for (const shapeCase of CASES) {
    if (shapeCase.uncapped) {
      queries.push({
        label: `${shapeCase.label} | uncapped, messages`,
        stats: summarizeLatencies(
          await timeQuery(
            () => sql.unsafe(uncappedQuery("messages", shapeCase.tsquery, false)),
            ITERATIONS_PER_QUERY,
          ),
        ),
      });
    }
    queries.push({
      label: `${shapeCase.label} | capped, messages`,
      stats: summarizeLatencies(
        await timeQuery(
          () => sql.unsafe(cappedQuery("messages", shapeCase.tsquery, false)),
          ITERATIONS_PER_QUERY,
        ),
      ),
    });
    queries.push({
      label: `${shapeCase.label} | capped, side table`,
      stats: summarizeLatencies(
        await timeQuery(
          () => sql.unsafe(cappedQuery("side", shapeCase.tsquery, false)),
          ITERATIONS_PER_QUERY,
        ),
      ),
    });
    queries.push({
      label: `${shapeCase.label} | capped, side table + ts_headline`,
      stats: summarizeLatencies(
        await timeQuery(
          () => sql.unsafe(cappedQuery("side", shapeCase.tsquery, true)),
          ITERATIONS_PER_QUERY,
        ),
      ),
    });
  }

  return {
    sideTableBytes: Number(sideTableBytes),
    sideTableBuildMs,
    queries,
  };
}
