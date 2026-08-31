# Store-as-truth with a pending-mutation overlay; TanStack Query is not on the data path

The Local Cache is the single source of truth for everything the Client renders. Components subscribe to reactive `liveQuery` reads against it, and it has exactly two writers: "apply a server delta" and "enqueue an Optimistic Action". TanStack **Query is not on the mail data path** — its model ("the server is truth, the cache is stale, refetch on focus") is the precise inverse of local-first, and every offline and optimistic feature becomes a fight with its invalidation model. TanStack **Router remains central and unaffected**.

Optimistic results reach the screen as an **overlay, not an in-place mutation**: server state is written to base rows and never touched by the User, pending Optimistic Actions live as durable rows, and reads compute `base ⊕ pending` at query time.

## Considered Options

- **TanStack Query as the UI cache**, persisted via `persistQueryClient`, with deltas written into the query cache. Rejected per above; this ADR narrows [ADR-0002](0002-react-vite-spa-client.md), which named "Router/Query" before the data layer was designed.
- **Mutate base rows in place, keeping a before-state journal to undo on failure.** Rejected: it turns three cases that the overlay gets for free into bespoke reconciliation.
- **CRDTs / client-assigned order.** Never on the table — the Sync Backend is the single order-of-truth (`docs/research/0001-thin-client-native-compat-patterns.md`).

## Why the overlay

Three hard cases fall out of it at no cost:

- **Rollback is a row deletion**, and the re-render is automatic.
- **A server delta arriving mid-flight** writes to base rows without racing the optimistic value.
- **`Needs Reauth` holding the queue rather than failing it** (required by the account-management decision) becomes *the rows just sit there and the UI keeps showing them applied* — the exact required behavior, with no code of its own.

## Optimistic Action semantics

- **Semantic intents** (`archive(thread)`), not wire-level operations (`setFlags`): they survive protocol changes and read correctly in a debug view.
- A **client-generated ULID as idempotency key**, echoed by the Sync Backend. Non-negotiable given retries over flaky mobile networks.
- **Strict FIFO per Mail Account.** At single-household scale the parallelism buys nothing and serialization removes a class of ordering bug outright.
- **No coalescing** beyond the trivial case: a queued action exactly undone while still queued (star → unstar) drops both rows, because that is already the Undo button's mechanism. Nothing cleverer.
- **Pending Optimistic Actions render as applied, with no pending styling.** An archive performed offline looks identical to one that round-tripped. Badging queued rows would ask the User to mentally track a queue, which is the opposite of "everything optimistic"; the offline indicator is the one honest signal, and it is enough.

## Consequences

- **The `base ⊕ pending` overlay is computed in JS, not as a SQL join.** Irrelevant at tens of pending actions.
- **Two modules, two rules.** A `store` module is the only code importing Dexie, exposing reactive read hooks that *already apply the overlay* plus a single `enqueue(intent)`; a `sync` module is the only writer of base rows and the only holder of state tokens. Components read only through hooks and write only through `enqueue`; base rows are written only by `sync`. No component sees Dexie, a state token, or a queue row. With AI-assisted development a first-class constraint, the point of the seam is not testability — it is that the wrong move ("just write to the table") isn't reachable.
- **Dexie runs on the main thread**, with one tab elected leader via the **Web Locks API** to own the sync loop and the queue flush. `SharedWorker` was the conceptually clean answer and is out on a hard fact: Chrome for Android does not support it, and the phone PWA is in scope. A Web Lock auto-releases when its tab dies, so leader failover needs no heartbeats; Dexie's `liveQuery` already propagates cross-tab, so follower tabs stay live with no extra machinery. A dedicated worker was rejected *for now* because it adds a `structuredClone` hop to the read path the `<100ms` bar measures — the seam above makes moving reads into a worker a contained change if benchmarking demands it.
- **Cold start**: shell from the service-worker cache → paint chrome → read the **top page only** (~50 rows) of the last-active list window with the overlay applied; that paint is "interactive", and sync starts after it. Nothing on that path touches the network or scans the cache. Session validation runs in parallel and never blocks the paint (an expired session must keep rendering cached mail). The last-active Mail Account and view are restored from Device Preferences. Only a first-ever boot against an empty cache shows a loading state, and even then renders the first page as it arrives.
