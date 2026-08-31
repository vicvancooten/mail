# Client↔backend sync is one delta endpoint with per-collection state tokens

Sync is a single `POST /sync` carrying a map of `{collection → stateToken}`, scoped per Mail Account plus a set of User-scoped collections, returning per collection `{created, updated, destroyed, newState, hasMore}`. This is the concrete shape of the JMAP-*shaped, not literal* API that [ADR-0005](0005-typescript-sync-backend.md) committed to, and it is worth recording separately because future native Clients will speak it: the wire protocol is the hard-to-reverse artifact, not the UI.

Collections: `MailAccount`, `Thread` (list-row summary), `Message`, `Label`, `Verdict`, `ScreeningHold`, `Draft`, `PendingSend`, `Preference`. **Bodies are not a collection** — always an on-demand fetch. The contract is the shared zod-schema workspace package, additive-only within a protocol version, unknown fields ignored in both directions.

## Three deliberate divergences from JMAP

- **Changes come *with* payloads**, not JMAP's `/changes`-then-`/get` two-step. JMAP splits them because it is an interop protocol serving untrusted clients; we own both ends, and one round trip beats two on a phone. Payloads stay small because they are list-row projections, never bodies.
- **`reset: true` per collection** when a state token is too old or the underlying state was rebuilt (UIDVALIDITY change, Reset Gatekeeper): the Client discards that collection and re-bootstraps it. There is no silent partial state.
- **A mutation-flush response carries deltas too** — new tokens plus changes — so flushing the Optimistic Action queue and syncing are one round trip, and an optimistic action confirms without waiting for the next poll.

## Triggers and cadence

The Client syncs on cold boot, on `visibilitychange → visible` (rate-limited so alt-tabbing cannot hammer), on the `online` event, after every mutation flush (free, per above), and on a **30s interval while visible only — never while hidden**. A hidden tab polling is battery cost for nothing; push is the real answer for "changed while you weren't looking", so this polling cadence is the specified **fallback** that the notifications decision upgrades to a push signal. Nothing else changes when it does: push only replaces the *signal*, and the Client still pulls the deltas (push-then-pull, per `docs/research/0001-thin-client-native-compat-patterns.md`).

Failure handling splits, and the two halves must not share a code path:

- **Server unreachable** → exponential backoff with jitter to a ~60s cap, queue intact, retrying.
- **`Needs Reauth`** → stop, hold the queue indefinitely, surface a per-Mail-Account banner. Never retried.

## Consequences

- **The Client is silent when healthy**: no persistent sync indicator and no spinner on an optimistic action. State surfaces only on deviation — an offline indicator carrying the pending count, a `Needs Reauth` banner per Mail Account, and a rollback as the row visibly reverting plus a toast naming the action, with a retry. We assume success and show failures, rather than narrating successes; a chattering status light makes an app feel busy, and the feel of speed is the product.
- **Paging**: `hasMore` means "call again immediately", against a per-collection entity cap per response.
- Preferences ride this protocol like any other collection, at **User scope** (theme, auto-advance on/off and direction, Undo Send delay) and **Mail Account scope** (signature, notification toggle), edited offline through the ordinary Optimistic Action queue. **Device Preferences** (layout, density) are deliberately outside it — `localStorage`, never synced.
