# Compose works offline: a Composition is durable in the Local Cache

The composer is fully usable offline. A Composition is a durable row in the Client's
[Local Cache](../../CONTEXT.md) from its first keystroke, and autosave to the Sync Backend is an
Optimistic Action draining from the ADR-0010 overlay — so typed text is never held only in memory and
never only behind a network round trip. The Sync Backend remains the *authoritative* store; what
changes is the Client's autosave *target*.

This **amends [ADR-0012](./0012-drafts-live-in-the-sync-backend-and-push-to-imap.md)**, which said
autosave "writes there and nowhere else". That reading is right about authority and wrong about
durability: the Client is offline-first everywhere else, and a composer that loses a half-written mail
to a tunnel or a closed tab fails the same test ADR-0012 already said was worth code to prevent.

## Considered Options

- **Compose disabled while offline**: rejected. The Client shows last state and queues actions for
  every other Triage operation; a composer that refuses to open is the one place the offline story
  visibly breaks.
- **Compose works offline, text in memory only**: rejected. It looks identical to the durable version
  right up to the moment it loses the mail.

## Consequences

- **Autosave intents coalesce, last-write-wins per Composition** — the single deliberate exception to
  the FIFO, additive intent queue in
  [ADR-0010](./0010-store-as-truth-with-a-pending-mutation-overlay.md). Ten minutes of offline
  composition must not drain as twenty stale bodies.
- **Attachment bytes are durable too**: they go into the Local Cache (IndexedDB stores `Blob`s
  natively) and upload with the queue, so an offline attach behaves like an online one.
- **An offline send queues, and says so.** It becomes a Pending Send intent, and the Undo Send
  countdown starts only when the Sync Backend accepts it — the composer reports "will send when
  reconnected" rather than running a timer that is lying about what happens at zero.
- **The concurrent-edit rejection in ADR-0012 now has a real trigger.** Two devices composing the same
  Draft offline is the expected path into a stale `version`, not an exotic one, so "the draft changed
  on another device" is a first-class Client state rather than an error toast.
