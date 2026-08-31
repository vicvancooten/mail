# The Client's Local Cache is a bounded, disposable IndexedDB cache

The Client keeps a **Local Cache** in IndexedDB via Dexie holding a bounded working set — not a replica of the mailbox. It is disposable by construction: any schema change wipes and resyncs rather than migrating. The acceptance bar (`<1s` cold start, `<100ms` thread open from local data, held against a 250k-message / 80k-thread corpus per `docs/poc-scope.md`) is a statement about the *triage working set*, not the archive: a full envelope replica of that corpus is 75–125MB, which is a brutal first sync on a phone and a real eviction risk on iOS, and it buys exactly one thing — client-side search over full history.

## What the Local Cache holds

- **Entities** keyed by id (Thread summaries, Messages, bodies) under a cache budget. Metadata is capped by count per Mail Account; **bodies and inline attachments are the only things budgeted in bytes** (LRU against a floor derived from `navigator.storage.estimate()`), being the only unbounded-size content.
- **List windows**: per (Mail Account, view), the ordered ids the Client actually holds — **contiguous from newest, truncated at the bottom, with a cursor**. There is therefore only ever one hole per list, at the bottom, never in the middle: scrolling past it fetches the next page; offline, the list simply ends with an explicit "older mail needs a connection" affordance rather than silently lying.
- A guaranteed **floor** on first sync (newest ~500 threads per view per Mail Account) so an offline cold boot has real content, plus **any thread the User opens is pinned** into the entity cache regardless of age.

Deltas naming an entity outside the window are **ignored, never auto-fetched** (and evicted from any list window that held them). Creations carry their sort key, so the Client inserts into date-ordered lists itself — and every PoC view is date-ordered.

**Never evictable, under any storage pressure**: the Optimistic Action queue, preferences, Drafts with unsent local edits, and anything a pending Optimistic Action references. Those are user intent, not cache. Eviction runs on idle, never on a read path; `QuotaExceededError` triggers aggressive eviction and a retry rather than surfacing as a failure.

## Considered Options

- **OPFS SQLite/wasm**: the serious alternative, and its real argument was FTS5 over full history. Bounding the working set killed that argument, leaving ~1MB+ of wasm to fetch and instantiate against a `<1s` cold-start bar, OPFS's sharp edges on exactly the iOS platform where the PWA is most fragile, and a SQL planner for a store holding a few thousand threads.
- **Raw IndexedDB**: rejected because Dexie's `liveQuery` *is* the reactive read layer [ADR-0010](0010-store-as-truth-with-a-pending-mutation-overlay.md) needs, and its versioned migrations are precisely the part not worth hand-writing.
- **Full metadata replica** / **pure last-session cache**: the two ends this decision sits between. The first pays a phone-hostile first sync for full-history search; the second can't honor "cold boot with the backend down shows last state".
- **Hand-written Dexie migrations for mail data**: pure liability once the cache is single-digit MB and rebuildable in seconds.

## Consequences

- **Full-history search cannot execute in the Client.** This is a hard constraint handed to the search-architecture decision, and it is the outcome `docs/poc-scope.md` already anticipated ("a pure client-side index may not survive it").
- **Wipe-and-resync has one absolute exception: never wipe a non-empty Optimistic Action queue.** It holds unsent user intent — an archive performed on a train. Flush first; if it cannot flush (offline, `Needs Reauth`), the upgrade waits and the old data stays.
- The **service worker caches the app shell only — no API responses, ever.** Offline data is the Local Cache's job; an HTTP cache of mail state would be a second, un-reconcilable truth. Shell assets are versioned and precached so cold start never touches the network.
- Client updates **prompt, never auto-reload** — swapping the bundle out mid-triage is unacceptable, so a new version applies on the next cold start. The one override: the Sync Backend declares a **minimum supported Client version**, and below it the Client force-updates rather than making half-working calls. That is the likelier failure than schema drift, given migrate-on-boot upgrades mid-dogfood.
- `navigator.storage.persist()` is requested on first run as cheap insurance against eviction.
