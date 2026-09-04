# Undo is a real inverse action, never a cancellation of a queued one

Triage actions are Optimistic Actions: applied to the Local Cache's pending overlay instantly and
flushed to the Sync Backend immediately (ADR-0010). Undo could have been "delete the pending row
before the flush", which the mutation queue's coalescer already does for toggles whose exact inverse
is enqueued. We decided instead that every undoable action — Done, Trash, Snooze, Discard (#101),
and the Screener's Block, Deny, Spam (#102), and Block Alias (#103) decisions — gets a **real inverse
intent on the wire** (restore to Inbox, unsnooze, undiscard, unblock and restore), and that the Undo
toast enqueues that inverse like any other Optimistic Action. The coalescer then cancels a
still-queued original for free, and an already-applied one is reversed by the Sync Backend, so Undo
behaves identically whether the flush beat the User's finger or not.

## Considered Options

- **Cancel-before-send**: Undo works only while the original is still in the queue. Rejected because
  `enqueueMutation` calls `requestSyncNow()` on every enqueue, so the window is milliseconds online;
  Undo would be a control that works offline and fails online, which is backwards.
- **A client-side "hold" window** that delays the flush by the Undo duration. Rejected because it
  makes every action slower to reach the other devices and other IMAP clients by ten seconds, for
  the benefit of the rare undo, and reintroduces the "is it done yet" state ADR-0010 removed.

## Consequences

- Undo for Trash and Block is an IMAP move back out of Trash. A server that has already purged
  Trash cannot restore, and the toast's window (10 s, matching bulk Undo) is far inside any purge
  policy. Unblock stays future-only outside that window, as ADR-0008 says.
- Actions of the same kind within one window share one toast and one Undo, which reverses all of
  them; the inverse intents are enqueued one at a time — `undo-toast.ts`'s bucket holds one closure
  per folded action, and its single Undo button runs every one of them through the ordinary
  `enqueueMutation` path, each triggering its own immediate flush rather than one combined request —
  so a partially failed reversal still rolls back visibly per row like any other rejection.
- `restoreToInbox` is also what the Screener's Approve already does to held Threads, so it is not a
  new server capability, only a new intent name.
