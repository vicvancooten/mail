# Search runs in the Sync Backend over a bounded candidate window

Search executes in the Sync Backend as Postgres full-text search over a dedicated **Search Index** table, never as a client-side index over full history: [ADR-0009](0009-client-local-cache-is-a-disposable-indexeddb-cache.md) already bounds the Local Cache to a working set, and `docs/research/0007-250k-message-corpus-benchmark.md` measured a full client index at ~1.33GB of JS heap and a ~194MB serialized blob at the 250k-message scale bar — unaffordable on the phone PWA. The Client still contributes an instant unindexed prefilter over what it already holds, so search feels local and degrades to "recent mail only" offline instead of vanishing.

The query is **recency-bounded**, which is the non-obvious half of this decision. Re-measuring the *ranked, thread-deduped* query shape (0007 only ever measured match-and-limit-50) breaks the 200ms bar in `docs/poc-scope.md`: searching an address local part cost ~957ms p50 uncapped, and ad-hoc runs against a colder table put a two-character prefix at 2.4s and a very common term at 642ms p99. Ranking a whole match set over a 15-year archive is unbounded work by construction. Bounding the candidate set to the newest 500 matching messages and ranking *within* it brings ordinary queries to 7–9ms p50, and holds every pathological case measured (two-char prefix, a term matching 82% of the corpus) between 118 and 168ms — under the bar. Numbers are reproducible with `pnpm --filter @mail/corpus-bench bench:shapes`; see `docs/research/0007-250k-message-corpus-benchmark.md`.

## The Search Index

A narrow `message_search` row per message — `message_id`, `mail_account_id`, `thread_id`, `folder`, `sent_at`, `doc tsvector`, `index_version` — written in the same transaction as the message, with a GIN index on `doc` and a btree on `(mail_account_id, sent_at DESC)`.

`doc` is built with the `simple` configuration plus `unaccent` — **no stemming**. A stemmed configuration is one language per index, and this mailbox is Dutch and English mixed inside single threads; prefix matching on the trailing query token recovers most of what stemming would have given without a language-detection problem that has no good answer at ingest time. Weights:

- **A** — subject
- **B** — participants: `From`/`To`/`Cc` display names and full addresses
- **C** — address parts: addresses split on non-alphanumerics into local-part and domain-label tokens. Postgres' parser treats `vic.van.cooten@a-insights.eu` as a single atomic token, so without this, free-text `insights` or `cooten` finds nothing and searching by sender would require syntax. This weight is what makes the most common search in a mail client work without the user remembering anything.
- **D** — body plaintext, and attachment **filenames**. Attachment *contents* are out of scope per `docs/poc-scope.md`.

## The query

1. **Candidate Window**: the newest 500 messages matching the tsquery within the account and folder filter, by `sent_at DESC`.
2. Dedup to threads — `DISTINCT ON (thread_id)`, best-scoring message wins, and *its* id travels with the row so opening a result lands the User at the message that matched, in its thread.
3. Score: `ts_rank_cd` blended with an exponential recency decay.
4. Top 50, with a `ts_headline` fragment per row (measured at +1–3ms over the whole page — the cheap part, contrary to expectation).

Minimum query length is 3 characters; the trailing token gets `:*` prefix treatment only at ≥3 characters, earlier tokens are exact-match AND. The Client's query parser strips a small English+Dutch stopword list before sending (a query of *only* stopwords is run as-is) — `simple` ships no stopword list, and fixing that server-side would mean a custom Postgres image, which is a bad trade against [ADR-0009](0009-deployment-is-a-single-image-two-service-compose.md)'s stock two-service compose for what is ultimately a word list.

Default scope is the **current Mail Account**, all folders except Trash and Junk. Cross-account search is deferred, and is one flag on the query when it arrives. Screening-held and Blocked mail is findable and badged; because Block moves mail to Trash for real ([ADR-0008](0008-blocking-moves-mail-to-trash.md)), blocked mail is reachable via the Trash filter rather than ranked into default results.

## Wire shape

A separate `POST /search`, deliberately outside [ADR-0011](0011-one-delta-endpoint-with-per-collection-state-tokens.md)'s delta protocol: a stateless query is not a synced collection. The request carries **structured filter fields** (account, folder, from, has-attachment, date range) — the parser lives in the Client and the wire contract stays typed in the shared zod package; the backend never re-parses a query string.

A result row carries the thread id, the matched message id, the **same `Thread` list-row projection ADR-0011 already defines**, the headline fragment, the folder, and Gatekeeper status. One renderer, and a result row that can be pinned into the Local Cache unchanged. The response also carries the Candidate Window cursor and the account's Index Watermark.

Paging is "load older": the next-older window of 500 matches, ranked and appended, keyset on `sent_at`. A score keyset was the obvious alternative and is worse — it is unstable under concurrent new mail, and "and older" is what a mail search means anyway. There are **no result totals**: the true count is a second unbounded query, and it is a search-engine habit nobody acts on in a mailbox.

## Consequences

- **A strongly-matching old message can lose to a weakly-matching recent one**, because the old one never enters the Candidate Window. This is the price of the bar, and it is the same recency bias the scoring already wanted — enforced where it is cheap. "Load older" is the escape hatch.
- **Body coverage converges rather than being instant.** ADR-0005's backfill fetches bodies lazily, so a throttled, resumable background sweep runs once per Mail Account until every body is fetched and indexed, then stops for good. Headers are indexed from the first sync, so envelope search is complete immediately. The per-account **Index Watermark** surfaces "bodies back to <date>" in the search UI *only* while the sweep is incomplete — silently partial results are the worst thing a mail search can do, and a 15-year import would hit that on day one.
- **The index is re-buildable without touching the mail table.** The analyzer config will change (stopwords, address rules, weights); a bumped `index_version` triggers a background, batched, oldest-version-first rebuild while search keeps serving old rows. This is the main reason the index is a side table rather than a generated column on `messages`: a generated column would mean a table rewrite inside ADR-0009's migrate-on-boot, i.e. a startup stall mid-dogfood. The narrow table also takes ~20% off worst-case latency (119ms vs 145ms on the 82%-selectivity query, 117ms vs 144ms on the address-part query) by keeping ranking off wide, toasted rows — at a cost of ~450MB beside the corpus.
- **The Client runs a prefilter, not a second ranker**: case-insensitive substring over subject, sender name, sender address and Snippet across the bounded Local Cache, date-ordered, rendered identically to server results and replaced wholesale when they arrive (skipping the re-render when they agree). Offline it *is* the result, with an explicit "recent mail only — older needs a connection" affordance; on `Needs Reauth` that account's search is unavailable with a banner and no retry loop.
- **Triage works on result rows** (universal right-click menu on email rows, hover icons in search), which means acting on a result **materializes and pins that thread into the Local Cache** so ADR-0010's `base ⊕ pending` overlay has a base to render and roll back. An acted-on row **stays in place, visibly changed**: archiving does not stop a message matching the query, and a vanishing row makes a results list feel like it is eating mail. Gatekeeper verdicts are not among these actions — they live in the Screener.
- **Drafts and Pending Sends are not searchable at PoC.** A Composition has no thread, folder or sender and would need its own index path, for a small-N problem the drafts view already solves.
