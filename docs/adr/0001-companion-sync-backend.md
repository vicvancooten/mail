# Companion sync backend between clients and mail servers

Browsers cannot speak IMAP, and the product goals (speed, offline, optimistic actions, snooze/Gatekeeper state shared across devices) need a hot server-side store. We deploy a self-hosted Sync Backend that speaks IMAP/SMTP to the user's existing mail servers, maintains a synced store, and serves all Clients a fast modern API. Clients never talk to mail servers directly.

## Considered Options

- **JMAP-only, browser-direct**: rejected — the JMAP server market is tiny (Fastmail, Stalwart); "bring your own server" means IMAP in practice. The Sync Backend's API should still be designed JMAP-ish so direct JMAP support can come later.
- **Thin stateless IMAP↔HTTP proxy**: rejected — pushes sync, caching, and cross-device state into each client, killing speed and making features like Gatekeeper and Snooze per-device.

## Consequences

- The project is two artifacts in one monorepo (`vicvancooten/mail`): the Sync Backend and the web Client.
- Running mail infrastructure (delivery, spam, storage of record) stays out of scope: the user's mail server remains the source of truth for mail itself.
- Future native clients should stay thin: behavior and state live server-side wherever possible so client updates are rare.
