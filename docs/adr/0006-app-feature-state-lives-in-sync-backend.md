# App Feature state lives in the Sync Backend, not on the IMAP server

Threads carry two kinds of state: features IMAP already models well (read, starred) and Mail-specific ones it doesn't (Pin, Label, Snooze, Gatekeeper verdicts, the screening hold). Every new feature defaults to the Sync Backend's own store — an App Feature — and is only promoted to a real IMAP flag or folder — a Protocol Feature — when the mapping is clean and near-universal across the PoC's target providers (own server/Dovecot, Fastmail-class, Gmail via app password). Read (`\Seen`) and starred (`\Flagged`) clear that bar; nothing else currently does.

## Considered Options

- **IMAP-native by default** (map every feature onto a real flag/folder wherever remotely plausible): rejected — Gmail exposes its labels as IMAP folders while generic IMAP servers only offer arbitrary keyword flags, so unifying the two per feature invites provider-specific bugs and namespace pollution for a PoC where Mail is expected to become the primary client per account anyway.
- **Folder moves for Snooze and the Gatekeeper screening hold** (so the hidden/held state is visible to any other IMAP client too): rejected — no protocol concept for either exists to map onto, and a message vanishing from Inbox and reappearing later reads as data loss to any other client watching the same mailbox.

## Consequences

- Pin, Label, Snooze, and Gatekeeper verdicts have zero IMAP-side trace: dropping the Sync Backend loses that state entirely. Accepted — Mail is meant to become the primary client per Mail Account, and there's no active requirement to keep other IMAP clients' view of the mailbox cosmetically clean.
- Read/starred still round-trip normally: any client marking a message read or starred is reflected in Mail and vice versa, written through to IMAP asynchronously after the Client's optimistic ack, reconciled via the existing state-token sync loop on failure — the same rollback path as any other Optimistic Action.
- Snooze's wake is a notification-triggering event (a fresh push when the wake time arrives), independent of this ADR's placement question — the notification mechanism itself is a separate, not-yet-specified decision.
