# 250k-message corpus & search-latency benchmark

Resolution of wayfinder ticket [250k-message corpus & benchmark harness](https://github.com/vicvancooten/mail/issues/23).
Harness and full source: [`apps/corpus-bench`](../../apps/corpus-bench); reproduce with
`pnpm --filter @mail/corpus-bench bench:all` against `compose.dev.yaml`'s Postgres and GreenMail.
Baseline numbers below are from `CORPUS_SEED=230823` (the default), captured 2026-08-31.

## Scope

At the time this ran, the Sync Backend has no real Message/Thread schema (only a placeholder
`scaffold_probe` table) and the Client has no list/search/triage UI. The ticket as originally
written asked for baseline numbers on all five PoC acceptance-bar metrics (cold start, thread open,
triage feedback, search first-results, list scroll); four of those five need implementations that
don't exist yet to time. Scoped down (with Vic) to what's actually build-able now and what this
ticket exists to unblock: **search latency**, the input [Search architecture](https://github.com/vicvancooten/mail/issues/11)
is waiting on ("a pure client-side index may not survive this corpus" — `docs/poc-scope.md`).
Cold start / thread open / triage feedback / list scroll stay benchmarked once the Client and real
schema land, reusing this same corpus generator and loaders.

## The corpus

250,000 messages / 80,000 threads / 2 Mail Accounts (`docs/poc-scope.md`'s scale bar), generated
deterministically from a seeded PRNG — see `apps/corpus-bench/README.md` for the full shape
(thread-depth distribution, sender cardinality, date spread, HTML/attachment rates). Ten
"needle" vocabulary terms are seeded at controlled, spread-out frequency so search queries have
real hits at known selectivity, from ~3.4% of messages down to 0.01%.

## Loading

| | Result |
|---|---|
| **Postgres** (`corpus_bench.messages`, single throwaway schema, GIN-indexed `tsvector`) | 250,000 rows in 59.7s (~4,190 rows/s), batched multi-row `INSERT` from one Node process, no COPY/parallelism |
| **IMAP** (GreenMail, 2 accounts, real `APPEND`) | 250,000 messages in 251.3s (~1.0ms/message) |

Both loaders are real, reusable groundwork independent of the Message/Thread schema decision still
to come — see the harness README for the full-load commands.

## Search latency: Postgres full-text search

`tsvector` (subject weight A, body weight B) + GIN index, 250,000 rows, index size **33.4 MB**.
40 iterations per query, `plainto_tsquery`/`phraseto_tsquery`, warm cache (no cold-cache numbers
captured — the PoC's is a long-running process, so warm is the realistic case).

| Query | Matches | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| `quarterly` (~3.4% selectivity) | 8,427 | 6.5ms | 7.5ms | 8.4ms |
| `migration` | 6,889 | 4.6ms | 6.7ms | 6.8ms |
| `onboarding` | 5,636 | 3.9ms | 4.9ms | 5.2ms |
| `invoice` | 4,521 | 3.1ms | 3.7ms | 7.3ms |
| `roadmap` | 3,320 | 2.4ms | 3.1ms | 3.4ms |
| `retrospective` | 2,319 | 1.9ms | 2.3ms | 2.4ms |
| `gatekeeper` | 1,293 | 1.4ms | 1.9ms | 1.9ms |
| `kestrelproject` | 305 | 1.0ms | 1.4ms | 1.5ms |
| `brontide` | 84 | 0.9ms | 1.0ms | 1.0ms |
| `quillfeather` (0.01%) | 26 | 0.8ms | 1.0ms | 1.0ms |
| phrase `"quarterly budget"` | — | 12.8ms | 24.1ms | 26.6ms |
| `invoice` + account filter + exclude Trash | — | 11.2ms | 12.7ms | 12.9ms |

**Every query, including worst-case p99, lands well under the 200ms search bar** — an order of
magnitude of headroom at this corpus size.

## Search latency: client-side index (MiniSearch, in-process Node stand-in for a Web Worker)

| Metric | Value |
|---|---:|
| Build time (250k docs, one thread) | 23.9s |
| JS heap growth for the index alone | **1.33 GB** |
| Serialized index (the IndexedDB-persisted blob) | **193.6 MB** |

Query latency (40 iterations/query, index warm):

| Query | Matches | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| `quarterly` | 8,427 | 8.8ms | 13.1ms | 29.2ms |
| `migration` | 6,889 | 6.9ms | 10.4ms | 18.6ms |
| `onboarding` | 5,636 | 5.8ms | 10.5ms | 11.3ms |
| `invoice` | 4,521 | 4.7ms | 8.9ms | 10.3ms |
| `roadmap` | 3,320 | 2.4ms | 5.3ms | 144.8ms |
| `retrospective` | 2,319 | 1.6ms | 4.6ms | 5.6ms |
| `gatekeeper` | 1,293 | 0.9ms | 1.2ms | 1.5ms |
| `kestrelproject` | 305 | 0.18ms | 0.25ms | 0.40ms |
| `brontide` | 84 | 0.03ms | 0.07ms | 0.12ms |
| `quillfeather` | 26 | 0.01ms | 0.02ms | 0.05ms |
| phrase `"quarterly budget"` (AND) | — | 92.1ms | 152.8ms | 491.4ms |

Typical-case query latency is comparable to or faster than Postgres (once built, a hot in-memory
index beats a round trip). But two numbers are the actual finding here:

- **Memory**: ~1.33 GB of JS heap for the index alone, on top of holding the 250k source documents
  to build it — before the rest of the app's own memory. That's a serious number against the PoC's
  own **phone PWA** bar (`docs/poc-scope.md`), where browser tab memory budgets run far below what a
  desktop Node process has available, and it directly conflicts with [Client architecture & data
  layer](https://github.com/vicvancooten/mail/issues/10)'s bounded-working-set design (a ~500-thread
  floor, not the full corpus, is deliberately what the Local Cache holds).
- **Tail latency**: multi-word/AND queries show real GC-pressure spikes (p99 491ms on the phrase
  query, one single-term p99 at 145ms) — both already over the 200ms bar, and this is a desktop
  Node process with no other work competing for the main thread, not a phone under load.

## Reading for #11

This doesn't decide [Search architecture](https://github.com/vicvancooten/mail/issues/11), but it
answers the question this ticket exists to unblock: **a pure client-side index does not
comfortably survive 250k messages** — the 200ms bar itself isn't the binding constraint (both
approaches mostly clear it), memory is. Postgres full-text search clears the bar with an order of
magnitude of headroom at a 33MB index. A viable client-side story likely means bounding what's
indexed client-side (matching the Local Cache's own bounded-working-set model) rather than a full
15-year, 250k-message index — or leaning on server-side search with the client only caching recent
results. That trade-off is #11's to make.
