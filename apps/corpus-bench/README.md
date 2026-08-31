# @mail/corpus-bench

Resolution of wayfinder ticket [#23](https://github.com/vicvancooten/mail/issues/23): a synthetic
corpus generator and search-latency benchmark harness, sized against the PoC's scale bar (250,000
messages / ~80,000 threads across 2 Mail Accounts — see `docs/poc-scope.md`).

**Scope note**: at the time this was built, the Sync Backend has no real Message/Thread schema and
the Client has no list/search/triage UI — only a placeholder `scaffold_probe` table and an empty
`App.tsx` exist. Benchmarking cold start, thread open, triage feedback, and list scroll needs those
implementations to exist first, so this harness measures only what's build-able against the current
repo: corpus generation, loading, and **search latency** — the piece [Search architecture](https://github.com/vicvancooten/mail/issues/11)
is blocked on ("a pure client-side index may not survive this corpus"). The generator and loaders
are still useful groundwork for the full acceptance-bar benchmark once the Client and real schema
land; re-running them against that later is expected, not a redo.

## The corpus

`src/generate.ts` yields messages lazily from a seeded PRNG (`src/rng.ts`, mulberry32) — the same
`CORPUS_SEED` always reproduces byte-identical output, so this package ships a generator instead of
a multi-GB fixture. Shape:

- Thread depth: heavily front-loaded on single-message threads with a long tail up to ~120-message
  conversations (`THREAD_DEPTH_BUCKETS` in `generate.ts`), adjusted to sum to exactly
  `CORPUS_MESSAGE_COUNT`.
- Sender cardinality: a 3,000-correspondent pool (`vocab.ts`), drawn per-thread with a Zipf-biased
  rank so a handful of contacts dominate a long tail of one-off senders.
- Dates: spread across a 15-year window ending 2026-08-31, exponentially skewed toward recent (mean
  recency ~2.5 years) — a real 15-year mailbox is dense recently and thin in its early history.
- Body size: log-normal-ish, ~94% short (15–a few hundred words), ~6% long (800–3,000 words, a
  digest/newsletter shape).
- HTML vs. plain: 65% multipart (text + HTML), 35% plain-only.
- Attachments: 10% of messages carry 1–3; IMAP APPEND uses a small fixed placeholder body regardless
  of the (still-realistic) `sizeBytes` metadata — see `mime.ts` for why.
- Search vocabulary: `NEEDLE_TERMS` in `vocab.ts` are ten distinctive terms seeded at controlled,
  spread-out frequency (~15% of messages down to <0.1%) so every search benchmark query has real,
  known-selectivity hits — a query against literal noise wouldn't tell you anything about the
  search decision this exists to unblock.

## Running it

Needs `compose.dev.yaml`'s `postgres` and `imap-test` services up (see `docs/dev-setup.md`), and the
env vars in `.env` (or defaults: `DATABASE_URL` → local dev Postgres, `IMAP_TEST_HOST`/`PORT` →
GreenMail).

```sh
pnpm --filter @mail/corpus-bench generate           # sanity-print corpus shape, no side effects

pnpm --filter @mail/corpus-bench load:postgres -- --reset   # loads corpus_bench.messages (throwaway schema)
pnpm --filter @mail/corpus-bench bench:postgres              # FTS query latency, p50/p95/p99

pnpm --filter @mail/corpus-bench bench:client                 # MiniSearch build time, memory, query latency

pnpm --filter @mail/corpus-bench load:imap                     # APPENDs a sample into GreenMail (see below)

pnpm --filter @mail/corpus-bench bench:all                      # generate + load:postgres(reset) + both benchmarks,
                                                                  # writes results/latest.json
```

Config is env vars (`src/env.ts`), all defaulted to the PoC scale bar:

| Var | Default | |
|---|---|---|
| `CORPUS_SEED` | `230823` | fixed — re-running `generate` reproduces the same corpus |
| `CORPUS_MESSAGE_COUNT` | `250000` | |
| `CORPUS_THREAD_COUNT` | `80000` | |
| `CORPUS_MAIL_ACCOUNTS` | `2` | |
| `CORPUS_IMAP_SAMPLE` | `5000` | `load:imap` samples by default. Measured against local GreenMail: ~1ms/message, so a full 250k load takes ~4 minutes — pass `CORPUS_IMAP_SAMPLE=0` to run it. |

`corpus_bench` is its own Postgres **schema** (`load-postgres.ts`), never `public` — a throwaway
stand-in for the real Message/Thread tables, not a preview of that design. `--reset` drops it first;
omit it to load additively. `results/latest.json` (gitignored) is `bench:all`'s full report; the
baseline numbers as of this ticket's resolution are recorded in the ticket's resolution comment.
