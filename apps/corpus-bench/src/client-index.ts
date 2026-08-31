import MiniSearch from "minisearch";
import { generateCorpus } from "./generate.js";
import { type LatencyStats, summarizeLatencies } from "./stats.js";
import type { CorpusConfig } from "./types.js";
import { NEEDLE_TERMS } from "./vocab.js";

const ITERATIONS_PER_QUERY = 40;

interface IndexedDoc {
  id: string;
  threadId: string;
  subject: string;
  bodyText: string;
}

export interface ClientIndexQueryResult {
  label: string;
  matchCount: number;
  stats: LatencyStats;
}

export interface ClientIndexBenchResult {
  docCount: number;
  buildTimeMs: number;
  heapUsedDeltaBytes: number;
  serializedIndexBytes: number;
  queries: ClientIndexQueryResult[];
}

/**
 * Builds a MiniSearch full-text index over the whole corpus in-process and
 * benchmarks it — a stand-in for "a Web Worker holding the index in memory,
 * hydrated from IndexedDB" (MiniSearch supports exactly that load/dump
 * cycle via toJSON/loadJSON). This is the client-side half of #11's
 * question: build time, memory, serialized size, and query latency at
 * 250k-message scale.
 */
export async function benchClientIndex(config: CorpusConfig): Promise<ClientIndexBenchResult> {
  const docs: IndexedDoc[] = [];
  for (const message of generateCorpus(config)) {
    docs.push({
      id: message.id,
      threadId: message.threadId,
      subject: message.subject,
      bodyText: message.bodyText,
    });
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const buildStart = performance.now();
  const index = new MiniSearch<IndexedDoc>({
    idField: "id",
    fields: ["subject", "bodyText"],
    storeFields: ["threadId", "subject"],
  });
  index.addAll(docs);
  const buildTimeMs = performance.now() - buildStart;
  const heapAfter = process.memoryUsage().heapUsed;

  const serializedIndexBytes = Buffer.byteLength(JSON.stringify(index.toJSON()));

  const queries: ClientIndexQueryResult[] = [];
  for (const { term } of NEEDLE_TERMS) {
    const samples: number[] = [];
    let matchCount = 0;
    for (let i = 0; i < ITERATIONS_PER_QUERY; i++) {
      const start = performance.now();
      const results = index.search(term, { prefix: false, fuzzy: false });
      samples.push(performance.now() - start);
      matchCount = results.length;
    }
    queries.push({ label: `term:${term}`, matchCount, stats: summarizeLatencies(samples) });
  }

  const phraseSamples: number[] = [];
  for (let i = 0; i < ITERATIONS_PER_QUERY; i++) {
    const start = performance.now();
    index.search("quarterly budget", { combineWith: "AND" });
    phraseSamples.push(performance.now() - start);
  }
  queries.push({
    label: "phrase:'quarterly budget' (AND)",
    matchCount: -1,
    stats: summarizeLatencies(phraseSamples),
  });

  return {
    docCount: docs.length,
    buildTimeMs,
    heapUsedDeltaBytes: heapAfter - heapBefore,
    serializedIndexBytes,
    queries,
  };
}
