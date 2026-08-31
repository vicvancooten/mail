# Mail PoC spec

Resolution of wayfinder ticket [#14](https://github.com/vicvancooten/mail/issues/14). This document
folds every decision the wayfinder map ([#1](https://github.com/vicvancooten/mail/issues/1)) closed
into one implementer-facing reference. It is an index with teeth: each section states the operative
requirements and points at the ADR, research doc, or spec that holds the full rationale. Where this
document and an ADR disagree, the ADR wins.

The **scope contract** — what is in, what is deferred, and the acceptance bar — is
[`docs/poc-scope.md`](poc-scope.md). The glossary is [`CONTEXT.md`](../CONTEXT.md); use its terms
exactly. The implementation backlog lives on the tracker as sub-issues of the **PoC implementation**
grouping issue.

## System shape

- One pnpm monorepo: `apps/client` (React 19 + Vite + TanStack Router SPA/PWA —
  [ADR-0002](adr/0002-react-vite-spa-client.md)), `apps/sync-backend` (Fastify + Drizzle/Postgres on
  Node 22 — [ADR-0005](adr/0005-typescript-sync-backend.md)), `packages/shared` (the zod wire
  contract). Layout, commands, CI: [`docs/dev-setup.md`](dev-setup.md).
- The Sync Backend is a **companion server** ([ADR-0001](adr/0001-companion-sync-backend.md)): it
  speaks IMAP/SMTP to the user's existing mail servers and holds the authoritative store. Clients
  talk only to it.
- Production is **one image, two services** (`app`, `postgres`), env-var-only config,
  migrate-on-boot under an advisory lock
  ([ADR-0009 deployment](adr/0009-deployment-is-a-single-image-two-service-compose.md)). Fastify
  serves both the API and the client bundle it was built with.
- Single process for the PoC; the sync engine is a liftable module.
- TanStack Query is **off the mail data path** (Router stays) — the Local Cache is the source the UI
  renders from ([ADR-0010](adr/0010-store-as-truth-with-a-pending-mutation-overlay.md)).

## Auth & Users

From [Account management & credential security model](https://github.com/vicvancooten/mail/issues/7):

- Username + password (argon2id) always available; **TOTP** as optional 2FA; **passkeys** as an
  optional passwordless primary. OIDC is post-PoC behind the `AuthMethod` seam.
- Opaque DB-backed sessions in httpOnly cookies, ~60-day sliding expiry. Session expiry **never
  wipes the Client's Local Cache** — it degrades to a login prompt over last state.
- First-run claims the Owner via a **one-time token printed in the logs**
  ([ADR-0009 deployment](adr/0009-deployment-is-a-single-image-two-service-compose.md)); the
  operator CLI shipped in the image is the recovery escape hatch at PoC scope. No invite links, no
  System Mailer flows yet.
- A Mail Account belongs to exactly one User, no sharing
  ([ADR-0004](adr/0004-mail-account-belongs-to-one-user.md)).

## Mail Accounts & credentials

From [Mail Account setup & provider seam](https://github.com/vicvancooten/mail/issues/21) (survey:
`docs/research/0004`) and [ADR-0003](adr/0003-instance-held-credential-key.md):

- Adding a Mail Account is a **separate, repeatable step** from creating the User.
- Autodiscover order: `autoconfig.<domain>` → `.well-known/autoconfig` → RFC 6186 SRV → Mozilla
  ISPDB → **manual entry** (pre-filled with privateemail defaults when MX resolves to
  `mx1/mx2.privateemail.com`). Manual entry is first-class, not an edge case.
- Credentials are a **tagged union** (`password` now, `oauth` later as a peer), encrypted at rest
  with the instance-held `MAIL_CREDENTIAL_KEY` (AEAD keyed to the Mail Account id, `key_version`
  for rotation), **write-only across the API**.
- Rejected credentials park the account in **Needs Reauth**: syncing stops, queued Optimistic
  Actions hold rather than fail, and re-entering credentials resumes.

## Sync engine

From [Backend language & sync-engine architecture](https://github.com/vicvancooten/mail/issues/9)
([ADR-0005](adr/0005-typescript-sync-backend.md)):

- One IMAP connection per Mail Account (ImapFlow): **IDLE on INBOX**, QRESYNC/CONDSTORE deltas with
  a UID-diff fallback, other folders polled.
- **Full-history backfill, newest first, with lazy bodies**; a run-once background sweep fills
  bodies behind a per-account **Index Watermark**.
- HTML is **sanitized server-side at ingest** (research: `docs/research/0005`), so the Local Cache
  only ever holds clean HTML. The **Snippet** is derived once at store time.
- Triage state placement ([ADR-0006](adr/0006-app-feature-state-lives-in-sync-backend.md)): only
  read (`\Seen`) and starred (`\Flagged`) are **Protocol Features**, written through to IMAP
  asynchronously after the optimistic ack. Pin, Label, and Gatekeeper state are **App Features** —
  no IMAP-side trace. One exception: a Block's *effect* is a real IMAP move to `\Trash`
  ([ADR-0008](adr/0008-blocking-moves-mail-to-trash.md)).

## Wire API & client data layer

[ADR-0011](adr/0011-one-delta-endpoint-with-per-collection-state-tokens.md),
[ADR-0009 client](adr/0009-client-local-cache-is-a-disposable-indexeddb-cache.md),
[ADR-0010](adr/0010-store-as-truth-with-a-pending-mutation-overlay.md):

- One **`POST /sync`** endpoint with per-collection state tokens; responses carry payloads with
  changes, `reset: true` instead of silent partial state; mutation responses carry deltas. 30s
  polling while visible only. The Client is **silent when healthy** (one exception: the new-mail
  toast, per ADR-0015).
- The Client's **Local Cache** (IndexedDB/Dexie) is a *view-anchored bounded working set*: list
  windows contiguous-from-newest, ~500-thread floor per view, opened threads pinned, deltas for
  unknown entities ignored. Wipe-and-resync is the schema strategy; **never wipe a non-empty
  mutation queue**.
- Optimistic Actions are a **durable overlay** (`base ⊕ pending`): semantic intents, ULID
  idempotency keys, FIFO per Mail Account (exception: compose autosave coalesces last-write-wins,
  [ADR-0014](adr/0014-compose-works-offline.md)), rendered as applied with no pending styling.
  Rollback is a row deletion. Dexie runs on the main thread with a **Web Locks leader**.
- Service worker caches the **app shell only — no API caching, ever**.

## Reading & rendering

From [HTML email rendering & sanitization](https://github.com/vicvancooten/mail/issues/22) (survey:
`docs/research/0005`):

- **Sanitize twice**: at ingest (backend) and again immediately before render (client), so a
  sanitizer CVE fix retroactively covers the cached corpus.
- Render in an iframe with `sandbox` (no `allow-scripts` for mail content) plus a strict
  per-render-nonce CSP; size via `ResizeObserver` + `postMessage`; `cid:` images resolve to `blob:`
  URLs.
- **Remote images route through a backend image proxy**, gated live on the Approved-Sender verdict
  (default: blocked). Senders never see the viewer's IP.
- Dark mode honors sender `color-scheme` opt-in, else a selective double-invert filter. PDFs render
  via a pinned, scripting-disabled pdf.js in the same sandbox.

## Triage & views

From the [Core triage-loop prototype](https://github.com/vicvancooten/mail/issues/3) (writeup on
branch `prototype/triage-loop-ui`) and the scope contract:

- Actions: archive, trash, read/unread, star, pin, label (apply / remove / filter-by only),
  auto-advance with a direction setting. All optimistic with visible rollback.
- Two top-bar view modes — **Split** (default) and **List** — plus **Stream mode** as an
  independent opt-in that remembers the underlying choice. One shared `useTriage` hook so actions
  mean the same thing everywhere. Explicit prev/next chevrons alongside `j`/`k`/`h`/`l`; a complete
  keyboard-only inbox pass is an acceptance criterion.
- lucide-react + shadcn button conventions; the small animation token set from the prototype;
  keyboard-repeated paths deliberately un-animated.
- Threaded list with time-grouping headers (header specifics are still fog on the map — pick
  something reasonable, expect iteration).

## Compose & sending

The detailed spec is [`docs/compose-spec.md`](compose-spec.md)
([ADR-0007](adr/0007-undo-send-is-a-backend-held-pending-send.md),
[ADR-0012](adr/0012-drafts-live-in-the-sync-backend-and-push-to-imap.md),
[ADR-0013](adr/0013-composition-document-model.md), [ADR-0014](adr/0014-compose-works-offline.md)).
Load-bearing points:

- **TipTap v3** over a fixed mail-safe schema; the ProseMirror JSON document is the stored truth;
  mail HTML (inline styles only) + plaintext are **derived by a dedicated serialiser** at push and
  submit. Always `multipart/alternative`.
- A Draft and a Pending Send are **two statuses of one Composition row**. Autosave writes to the
  Sync Backend, plus a debounced MIME export to the IMAP `Drafts` folder (safety rules in
  ADR-0012: one UID per Composition, `APPEND`-don't-expunge on foreign edits, degrade if no Drafts
  folder).
- **Undo Send is backend-held**: `submit_after` + sweeper + atomic claim before Nodemailer; late
  cancel loses and says so; nothing is written to `Sent` until submission succeeds, then `APPEND`.
  Per-User delay `off/5/10/20/30`s, default 10, `off` = `N = 0`.
- **Compose works offline**: the Composition is a durable Local Cache row from the first keystroke;
  autosave is the one coalescing (LWW) Optimistic Action.
- Replies: **Quoted Original is an opaque non-editable node**; thread to *the message the User had
  open*; `References` truncated first + last ~20; the **Sync Backend mints the `Message-ID`**.
- Attachments upload on drop; pre-submission blobs in Postgres `bytea` behind a **Blob Store**
  seam; 25MB-encoded instance-config budget enforced live; send disabled while uploading; no
  received-attachment caching (fetch-through from IMAP).
- Recipient autocomplete from a per-Mail-Account **Correspondent** aggregate (sent ≫ received,
  recency decay), top ~500 synced for a <50ms first keystroke.
- One composer at a time, docked; `Esc` closes to a Draft, never discards. Permanent send failure
  → Draft badged with the SMTP rejection verbatim + push + banner.

## Search

[ADR-0016](adr/0016-search-runs-in-the-sync-backend-over-a-bounded-candidate-window.md) (numbers:
`docs/research/0007`):

- Search executes in the **Sync Backend** over a `message_search` side table: `simple` + `unaccent`,
  **no stemming**, weighting subject / participants / **split address parts** / body + filenames.
  The address-part split is load-bearing — without it sender search finds nothing.
- Rank only a **Candidate Window** of the newest 500 matches; "load older" pages the window back.
- Results are **Threads** (best-matching message id travels along; opening lands there), scoped to
  the current Mail Account, all folders but Trash/Junk, held/blocked mail findable and badged.
  `POST /search` reuses ADR-0011's `Thread` projection, structured filter fields, no totals.
- The Client runs an instant **prefilter, not a second ranker** (substring over the Local Cache),
  which *is* search when offline. Coverage is stated via the Index Watermark, never silent.
- Query syntax, filters, and the search surface are **still open on the map**
  ([#29](https://github.com/vicvancooten/mail/issues/29)) — the search UI ticket is blocked on it.

## Notifications & realtime

[ADR-0015](adr/0015-realtime-is-sse-hints-plus-web-push.md) (iOS constraints:
`docs/research/0006`):

- Two channels, one signal: **SSE** (`GET /events`) to open Clients, **Web Push** to closed ones.
  SSE carries only a **Sync Hint**; pushes **carry content** (sender/subject/Snippet) and the badge
  count. Fanout is Postgres `LISTEN/NOTIFY` **inside the writing transaction**, coalesced to ~1
  hint/500ms per User. The Web Locks leader tab owns **one** SSE connection and relays over
  `BroadcastChannel`.
- The **Notifier** owns policy: push-worthy is Approved-Sender Inbox mail, the coalesced Gatekeeper
  digest (then 4h silence), a permanently failed send, and entering Needs Reauth. De-duped on
  `(message_id, kind)`; per-account burst cap collapses to "N new messages"; only IDLE/delta
  arrivals are eligible (backfill and `reset: true` can never notify).
- A visible window suppresses the OS notification in favour of an inline toast. Notification
  actions `POST` direct with a ULID key + Background Sync retry — never through the overlay.
- Badge = unread Inbox threads from a **backend counter**: the SW push handler sets it from the
  push payload (`showNotification` awaited first, badge best-effort after), the leader tab sets it
  while open, `/sync` snaps it true on visibility change. Gatekeeper-held mail never counts. A
  denied device does not badge.
- Sync liveness is two-tier: per-account self-restart + banner; readiness fails only process-wide.
- Permission asked at most twice; a denied device stays fully functional.

## Gatekeeper v1

From the [Gatekeeper v1 spec](https://github.com/vicvancooten/mail/issues/12)
([ADR-0008](adr/0008-blocking-moves-mail-to-trash.md)). **Built last, by policy** — sequenced so it
can be cut without stalling anything else.

- Opt-in per Mail Account; Verdicts (Unscreened/Approved/Blocked) keyed to a normalized `From`
  address (no plus-tag stripping), domain verdicts as an overflow convenience (address beats
  domain; public providers barred), source + timestamp recorded on every verdict.
- Held only if a message starts a **new Thread**, in the **Inbox**, **after the Cutoff**, from an
  Unscreened sender. Enabling sets the Cutoff to now and **seeds Approved from Sent history**;
  sending approves live.
- The **Screener** lists held *senders*: **Approve** (release, original dates) / **Deny** (trash,
  stays Unscreened) / **Block** (trash + all future mail moved to `\Trash` on arrival). Nothing
  auto-expires. A non-dismissible Inbox banner keys to *unseen* holds.
- Corrections are future-only: Block is the sole off-switch for an Approved sender; a Blocked
  Senders list handles unblocking; **Reset Gatekeeper** clears all verdicts and re-seeds. Disabling
  releases every held Thread but keeps verdicts. Search returns held and blocked mail badged.

## Preferences

From the scope contract and
[Client architecture & data layer](https://github.com/vicvancooten/mail/issues/10):

- Synced preference collections at **User** scope (theme, auto-advance on/off + direction, Undo
  Send delay) and **Mail Account** scope (plain-text signature, notification on/off toggle).
- **Device Preferences** (layout, list density) deliberately never sync.

## Deployment & ops

[ADR-0009 deployment](adr/0009-deployment-is-a-single-image-two-service-compose.md):

- Images published to GHCR at `${MAIL_VERSION:-edge}` with immutable `:sha-<short>` rollback tags.
  Root `compose.yaml` pulls, never builds; `compose.dev.yaml` is dev infra only.
- `PUBLIC_URL` and `MAIL_CREDENTIAL_KEY` are required and fail closed; `MAIL_BIND` defaults to
  loopback; operator brings their own reverse proxy.
- Upgrade ritual: `pg_dump` → `pull` → `up -d`. Migrations are forward-only, run at boot behind an
  advisory lock, fail closed.

## Acceptance bar

The full table lives in [`docs/poc-scope.md`](poc-scope.md#acceptance-bar). The load-bearing
numbers: <1s cold start, <100ms thread open (from the Local Cache, never a network wait), <50ms
triage feedback, <200ms search — all held against the seeded **250k-message / 80k-thread corpus**
(`apps/corpus-bench` generates and loads it; `docs/research/0007` holds the baseline numbers).

## Build order

The backlog is the **PoC implementation** grouping issue's sub-issues, blocking-wired so an
assembly line can run them. Standing policies the edges don't express:

1. **Gatekeeper is built last** — it must be cuttable without stalling the line.
2. The **search UI** ticket stalls until
   [Search UX](https://github.com/vicvancooten/mail/issues/29) resolves on the map; the search
   *backend* is fully specified by ADR-0016 and does not wait.
3. Every ticket is measured against the scope contract's acceptance bar; performance regressions
   against the corpus are failures, not follow-ups.

## Still open on the map

- [Search UX: query syntax, filters & the search surface](https://github.com/vicvancooten/mail/issues/29) — gates the search UI ticket only.
- [Choose project license & CLA policy](https://github.com/vicvancooten/mail/issues/16) — gates open-sourcing, not the build.
- [Follow-up map: full feature set & native apps](https://github.com/vicvancooten/mail/issues/15) — everything the scope contract defers.
