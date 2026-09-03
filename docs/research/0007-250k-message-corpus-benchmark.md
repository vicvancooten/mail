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

## Correction: what these Postgres numbers do and do not cover (added by [#11](https://github.com/vicvancooten/mail/issues/11))

The Postgres table above measures **match-and-limit-50**: `WHERE search_doc @@ query … LIMIT 50`, with
no relevance ranking and no thread deduplication. That was the right shape for the question this
ticket asked (does full-history search need to run in the Client?), and the answer stands. But it is
narrower than the query [Search architecture](https://github.com/vicvancooten/mail/issues/11) went on
to specify — ranked by `ts_rank_cd` with a recency blend, deduplicated to one row per Thread — and the
difference is not small. Re-measured on this same corpus, same machine, `simple` configuration:

| Query shape (ranked + thread-deduped, top 50) | p50 | p95 |
|---|---:|---:|
| `quarterly` (~3.4% selectivity), **no candidate cap** | 30.1ms | 37.1ms |
| type-ahead prefix `quarte:*`, no cap | 30.5ms | 32.6ms |
| address local part `kowalski0`, no cap | 957.4ms | 1001.0ms |
| `quarterly`, **capped to the newest 500 matches** | 8.7ms | 14.9ms |
| `quarte:*`, capped | 9.4ms | 10.1ms |
| `kowalski0`, capped | 143.9ms | 156.7ms |
| `kowalski0`, capped, on a **narrow side table** | 117.0ms | 131.9ms |
| two-char prefix `qu:*`, capped / capped on side table | 155.5 / 129.1ms | 166.7 / 167.1ms |
| a term matching ~82% of the corpus, capped / side table | 145.4 / 118.9ms | 155.1 / 123.6ms |
| `ts_headline` fragments over the 50 result rows | +1–3ms | +1–3ms |

Ad-hoc runs of the uncapped shape on a colder table measured considerably worse than the table above
(p99 216ms for `quarterly`, 224ms for `quarte:*`, 642ms for the 82% term, and **2.4s** for a
two-character prefix), which is why `qu:*` and the 82% term are only benchmarked capped — uncapped
they are slow enough to make the run tedious. Either way the shape of the finding is the same, and
the capped numbers are the ones the design depends on.

Ranking a whole match set is unbounded work; the `LIMIT 50` in the original benchmark stops the scan
early precisely because nothing has to be ordered. So the 200ms bar **is** binding on the real query
shape, and the fix is bounding the candidate set rather than a different search engine — see
[ADR-0016](../adr/0016-search-runs-in-the-sync-backend-over-a-bounded-candidate-window.md). Two
incidental findings from the same pass: `ts_headline` snippets are essentially free at page size, and
`to_tsvector('simple', …)` treats an email address as one atomic token, so address parts have to be
split at index time or sender search silently fails.

Numbers above are from `pnpm --filter @mail/corpus-bench bench:shapes` (20 iterations/query, warm
cache, same corpus and machine as the tables higher up; the side table is 450MB and builds from the
loaded corpus in 7.7s). Absolute values move with hardware and cache warmth — the ratios are the
finding.

## Account Scope (added by [#68](https://github.com/vicvancooten/mail/issues/68))

[ADR-0016](../adr/0016-search-runs-in-the-sync-backend-over-a-bounded-candidate-window.md)'s
amendment activates cross-account search: a request can name several of the User's Mail Accounts,
each contributing its own Candidate Window, merged and re-ranked. "Measure the multi-account query
shape against the existing corpus bench before locking it in" is this section's brief.

`bench-shapes.ts` gained a `cappedMultiAccountQuery` case: the same per-account Candidate Window
shape as the existing `capped, side table` case, but unioned across several `mail_account_id`
values before ranking — mirroring `sync/search-query.ts#runSearch`'s real shape (still a hand-rolled
query against `corpus_bench`'s own tables, not a call into `runSearch` itself; see this file's own
top-of-function comment on that gap). Corpus regenerated with `CORPUS_MAIL_ACCOUNTS=3` (`quarterly
budget`'s scale bar, the ticket's own "three accounts" framing), same seed and message count, so per
account row counts drop from ~125k (the default 2-account corpus) to ~83k:

| Query shape (ranked + thread-deduped, top 50, capped, side table) | 1 account p50 | 3-account Scope p50 | ratio |
|---|---:|---:|---:|
| `quarterly` (~3.4%) | 9.5ms | 25.6ms | 2.7× |
| `quillfeather` (0.01%) | 3.7ms | 11.1ms | 3.0× |
| phrase `quarterly budget` | 8.6ms | 25.4ms | 2.9× |
| type-ahead prefix `quarte:*` | 8.4ms | 24.8ms | 3.0× |
| two-char prefix `qu:*` (pathological) | 85.1ms | 343.8ms | 4.0× |
| term matching ~82% of the corpus (pathological) | 91.0ms | 412.5ms | 4.5× |
| address local part `kowalski0` | 95.0ms | 319.9ms | 3.4× |

The four ordinary-selectivity shapes scale close to the ADR's "roughly ×N accounts" prediction and
land at 11–31ms at 3 accounts — nowhere near the 200ms bar. The three shapes already the most
expensive at one account (`qu:*`, the ~82% term, and this corpus's own `kowalski0` needle, which
turns out to match a large share of its account too — not the rare address part its label suggests)
scale a little worse than linear and **cross 200ms at 3 accounts** (320–413ms). Per-account windows
mean the Scope's worst case is its slowest account's own worst case times the account count, not
bounded by total corpus size, which is exactly the trade ADR-0016's amendment names and accepts
rather than papers over.

One side finding worth flagging for its own follow-up, independent of Account Scope: the EXPLAIN
plan for these three shapes shows Postgres choosing a full bitmap-heap scan (`Rows Removed by
Filter` in the tens of thousands) instead of the cheap "index-scan-with-early-limit-stop" plan the
ordinary shapes get — because the query's `tsquery` value arrives as a bound parameter / CTE output
rather than a plan-time literal, which defeats Postgres's per-lexeme selectivity stats for `tsvector`
columns. A throwaway same-predicate query with the term written as a literal ran in ~1ms against the
identical data where the parameterized form took ~90ms. `sync/search-query.ts#buildTsQuery` builds
its `tsquery` the same parameterized way today, so the single-account path already pays this cost on
its own two documented pathological cases — Account Scope just multiplies an existing cost, it
doesn't introduce a new one. Worth its own performance ticket; out of scope here.

Reproduce: `CORPUS_MAIL_ACCOUNTS=3 pnpm --filter @mail/corpus-bench load:postgres -- --reset` then
`pnpm --filter @mail/corpus-bench bench:shapes`.
