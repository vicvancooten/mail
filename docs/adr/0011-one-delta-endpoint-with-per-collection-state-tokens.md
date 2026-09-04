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

- **Amended by [ADR-0015](./0015-realtime-is-sse-hints-plus-web-push.md)** on two points. The "notifications decision" this ADR anticipated is settled: the push signal is an SSE Sync Hint to open Clients and Web Push to closed ones, and visible-only polling survives as a slow safety net rather than being replaced. And "silent when healthy" gains exactly one exception — new mail arriving raises an inline toast on a focused device. The rule still holds in its real form: never narrate *the system's own* success; external news is not the system's success.
- **The Client is silent when healthy**: no persistent sync indicator and no spinner on an optimistic action. State surfaces only on deviation — an offline indicator carrying the pending count, a `Needs Reauth` banner per Mail Account, and a rollback as the row visibly reverting plus a toast naming the action, with a retry. We assume success and show failures, rather than narrating successes; a chattering status light makes an app feel busy, and the feel of speed is the product.
- **Paging**: `hasMore` means "call again immediately", against a per-collection entity cap per response.
- Preferences ride this protocol like any other collection, at **User scope** (auto-advance on/off and direction, Undo Send delay) and **Mail Account scope** (signature, notification toggle), edited offline through the ordinary Optimistic Action queue. **Device Preferences** (layout, density, Appearance) are deliberately outside it — `localStorage`, never synced.
- **Amended by #72**: Appearance (theme) shipped at User scope above and is moved to a Device Preference here. A laptop and a phone in the same hour want different Appearances — the same reasoning that already kept layout and density out of this protocol applies to Appearance too; it was User-scoped only because it landed before that distinction was drawn this sharply. The `users.theme` column and the `setTheme` mutation are gone; the Client now reads and writes Appearance through `localStorage` (`apps/client/src/theme/device-theme.ts`), same posture as every other Device Preference.
- **Amended by #67 (Bulk Done batch endpoint)**: the Bulk Triage batch endpoint reuses `reset: true` for a new trigger. Past `BULK_TRIAGE_RESET_THRESHOLD` (200, `@mail/shared`) Threads affected on one Mail Account, the batch bumps that account's Thread rebuild epoch (`threadsEpoch`, the same column a UIDVALIDITY rebuild bumps) instead of leaving thousands of rows for the next `POST /sync` to page through as ordinary `updated` deltas. No new wire shape: the next Thread sync for that account answers `reset: true` and re-bootstraps through the mechanism this ADR already defines, exactly as if the underlying state had been rebuilt — which, from the Client's point of view, it effectively was.
