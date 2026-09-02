import type postgres from "postgres";
import { type LatencyStats, summarizeLatencies } from "./stats.js";
import { NEEDLE_TERMS } from "./vocab.js";

const SCHEMA = "corpus_bench";
const ITERATIONS_PER_QUERY = 40;

export interface PostgresQueryResult {
  label: string;
  matchCount: number;
  stats: LatencyStats;
}

export interface PostgresBenchResult {
  rowCount: number;
  indexSizeBytes: number;
  queries: PostgresQueryResult[];
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
 * Runs representative full-text queries against the loaded corpus_bench
 * schema: single terms across the selectivity range in vocab.ts's
 * NEEDLE_TERMS (from ~15% of messages down to a handful), a two-word
 * phrase, and a filtered query scoped to one Mail Account excluding Trash —
 * the shape of a real "search my inbox" query, not just a bare full-text
 * match. This is what the ticket's blocking question (#11: "does a pure
 * client-side index survive this corpus?") is measured against on the
 * server side of the comparison.
 */
export async function benchPostgresSearch(sql: postgres.Sql): Promise<PostgresBenchResult> {
  const [{ count: rowCount }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM ${sql(SCHEMA)}.messages
  `;
  const [{ size: indexSizeBytes }] = await sql<[{ size: string }]>`
    SELECT pg_total_relation_size('corpus_bench.messages_search_idx')::text AS size
  `;

  const queries: PostgresQueryResult[] = [];

  for (const { term } of NEEDLE_TERMS) {
    const [{ count: matchCount }] = await sql<[{ count: string }]>`
      SELECT count(*)::text AS count FROM ${sql(SCHEMA)}.messages
      WHERE search_doc @@ plainto_tsquery('english', ${term})
    `;
    const samples = await timeQuery(
      () => sql`
        SELECT id FROM ${sql(SCHEMA)}.messages
        WHERE search_doc @@ plainto_tsquery('english', ${term})
        ORDER BY sent_at DESC LIMIT 50
      `,
      ITERATIONS_PER_QUERY,
    );
    queries.push({
      label: `term:${term}`,
      matchCount: Number(matchCount),
      stats: summarizeLatencies(samples),
    });
  }

  const phraseSamples = await timeQuery(
    () => sql`
      SELECT id FROM ${sql(SCHEMA)}.messages
      WHERE search_doc @@ phraseto_tsquery('english', 'quarterly budget')
      ORDER BY sent_at DESC LIMIT 50
    `,
    ITERATIONS_PER_QUERY,
  );
  queries.push({
    label: "phrase:'quarterly budget'",
    matchCount: -1,
    stats: summarizeLatencies(phraseSamples),
  });

  const filteredSamples = await timeQuery(
    () => sql`
      SELECT id FROM ${sql(SCHEMA)}.messages
      WHERE search_doc @@ plainto_tsquery('english', 'invoice')
        AND mail_account_id = 1
        AND folder != 'Trash'
      ORDER BY sent_at DESC LIMIT 50
    `,
    ITERATIONS_PER_QUERY,
  );
  queries.push({
    label: "term:invoice + account filter + exclude Trash",
    matchCount: -1,
    stats: summarizeLatencies(filteredSamples),
  });

  return { rowCount: Number(rowCount), indexSizeBytes: Number(indexSizeBytes), queries };
}
