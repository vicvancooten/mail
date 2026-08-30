# TypeScript Sync Backend on Node, Fastify and Postgres

The Sync Backend is TypeScript on Node LTS: ImapFlow is the only actively-maintained IMAP library in any surveyed language documenting IDLE + CONDSTORE + QRESYNC + OAuth2 together, Nodemailer is uncontested for SMTP submission, and sharing a language with the Client lets one workspace package of zod schemas be the enforced API contract on both sides (see `docs/research/0003-imap-jmap-library-survey.md`). Storage is Postgres — with docker compose already the deployment story, SQLite's ops advantage evaporates, and Postgres keeps LISTEN/NOTIFY (push fanout) and multi-process sync workers available without a migration. The HTTP layer is Fastify serving a custom JMAP-*shaped* JSON API (state tokens, delta endpoints, push-then-pull per the thin-client research), not literal RFC 8620 — no Node JMAP server tooling exists and RFC compliance buys interop with almost no clients.

## Considered Options

- **Rust**: the only ecosystem with real sync-engine references (Delta Chat core, neverest) and citable capacity numbers (Stalwart). Rejected: no single crate covers the full IDLE+CONDSTORE+QRESYNC+OAuth2 stack (async-imap lacks QRESYNC; io-imap is young), and its capacity edge pays at thousands of mailboxes, not single-household scale. Its reference engines remain worth reading.
- **Go**: rejected on library maturity — no go-imap version cleanly covers CONDSTORE+QRESYNC, go-sasl deliberately dropped XOAUTH2 (unverified Gmail risk), and ProtonMail outgrowing go-imap into bespoke Gluon is evidence against the ecosystem.
- **SQLite**: excellent fit for a single-writer daemon, but its remaining benefits (in-process latency, single-file backup) don't outweigh Postgres's headroom once compose is a given.
- **Literal JMAP (RFC 8620/8621)**: would mean implementing the RFC from scratch (zero Node/TS server tooling) to gain interop with a near-empty client market. The API steals JMAP's *patterns* instead.
- **tRPC**: tempting for a proprietary API, but welds the wire format to TypeScript; future native clients must speak the same protocol, so it's plain HTTP/JSON with declared schemas.

## Consequences

- Sync-engine logic (UIDVALIDITY handling, resync, dedup, backfill) is hand-rolled on top of ImapFlow; nothing reusable exists in the ecosystem.
- Per-account sync: one IMAP connection per Mail Account holding IDLE on INBOX; deltas via QRESYNC/CONDSTORE with UID-diff fallback and full mailbox rebuild on UIDVALIDITY change; other mailboxes polled. Initial backfill is full-history, newest-first: envelopes/metadata for everything, bodies lazy with a cache budget — so search spans all mail.
- Single Node process runs the API and every account's sync loop for the PoC; the sync engine is a self-contained module (talks only to Postgres and IMAP) so it can be lifted into its own service if evidence demands.
- The Sync Backend is always connected: mail arrives server-side with no client open. Client notification (Web Push/SSE) is a separate delivery leg built on this.
