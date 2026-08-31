# Drafts live in the Sync Backend and are pushed to IMAP

A Draft is **App Feature** state: the Sync Backend's Postgres store is the system of record, and
autosave writes there and nowhere else. On top of that, a **debounced push** exports the Draft as a
MIME message into the Mail Account's IMAP `Drafts` folder, so a draft started in Mail is readable and
finishable in any other IMAP client. IMAP has no in-place message update — every save is an `APPEND`
plus an `EXPUNGE` of the previous version — so making the `Drafts` folder the system of record would
mean re-serialising the entire MIME, attachments included, every few seconds for the life of the
composer. Keeping IMAP as a pure export makes autosave cheap while still buying portability.

## Considered Options

- **IMAP `Drafts` folder as the system of record** (Protocol Feature): rejected. Portable by
  construction, but the autosave cost is prohibitive (a 20MB attachment re-uploaded on every save),
  RFC 8508 `REPLACE` support is not universal enough to rely on, and it would force a second,
  MIME-shaped representation of content that [ADR-0007](./0007-undo-send-is-a-backend-held-pending-send.md)
  already decided to hold as structured composition. Fails the "clean and near-universal mapping" bar
  in [ADR-0006](./0006-app-feature-state-lives-in-sync-backend.md).
- **Backend-only, no IMAP push at all**: the literal reading of the PoC scope contract
  ("server-side synced drafts with autosave"). Rejected as the end state — a draft invisible to every
  other client is a real gap once Mail holds a Mail Account's only copy of in-progress mail — but
  retained as the graceful degradation when no `Drafts` folder can be found.
- **One final `APPEND` when the composer closes**, instead of a debounced push: rejected. Buys thin
  portability (nothing is exported while you are actually writing) and still needs the
  delete-on-resume path, so it costs nearly as much as the debounced push for much less.
- **Two tables, Draft and Pending Send, with content copied between them on cancel**: rejected in
  favour of a single **Composition** entity whose status spans both. ADR-0007 already specifies that
  cancelling is "a status change on the same content"; two tables would make that a copy, which is
  the version of the path most likely to drift.
- **Attachment bytes on the filesystem or in an object store**: rejected for the PoC. The
  pre-submission store is transient (minutes, a handful of blobs) rather than a corpus, so Postgres
  `bytea` buys transactional lifecycle — deleting a Composition deletes its blobs, and the
  orphaned-file bug class does not exist — plus one backup story and no new volume or service in
  compose. A filesystem volume reintroduces orphans; MinIO adds a service for a few megabytes.

## Consequences

- **One entity, two states.** A single `Composition` row carries recipients, subject, body, and
  attachment references, with a status of `draft | pending | submitting | sent | failed`. Draft and
  Pending Send are states of it, not separate things. `submit_after` is null for a Draft.
- **Blob Store seam.** Attachment bytes live in Postgres `bytea` behind a narrow
  put/get/delete-by-id seam, so a filesystem or S3 implementation can replace it without touching
  compose logic. Known and accepted cost: `node-postgres` materialises a `bytea` as a whole `Buffer`,
  so a 25MB attachment is a 25MB allocation rather than a stream. Acceptable at this cap; the seam is
  what makes it fixable.
- **No encryption at rest for attachment blobs.** The whole message corpus (250k bodies) is stored in
  the clear, so encrypting only transient draft attachments would protect a rounding error while
  breaking streaming and adding key-version handling. Credentials are encrypted
  ([ADR-0003](./0003-instance-held-credential-key.md)) because they grant live access to an external
  system; message content does not.
- **Push cadence is debounced, never per-keystroke:** ~30s of composition idle, on composer close, and
  on explicit save — and skipped entirely when a `pushed_content_hash` matches the last push, so an
  idle-but-open composer pushes once. The pushed MIME carries full attachments (a portable draft
  missing its files is worse than no portable draft) and the `\Draft` and `\Seen` flags.
- **A failed push is never a user-visible error.** The App Feature is the system of record, so pushes
  retry silently, and a Mail Account in Needs Reauth simply stops pushing.
- **Folder discovery degrades, it does not create.** Locate the folder via RFC 6154 `\Drafts`
  special-use, then a short name heuristic; if nothing matches, **skip pushing** for that Mail Account
  and surface a quiet per-account note. Mail never creates a folder on the user's mail server as a
  side effect of typing.
- **One UID per Composition.** A message in `Drafts` whose UID matches a Composition's
  `imap_draft_uid` is ours and is skipped by inbound processing; anything else is foreign. This single
  rule prevents both the self-import loop and double-listing of Mail's own drafts.
- **Foreign edits are never destroyed.** Before superseding its copy, Mail checks that the stored UID
  still matches; if it does not, Mail `APPEND`s a new copy rather than expunging the changed one, so a
  foreign edit becomes a second draft instead of lost text.
- **Deletion is asymmetric.** A Mail-side delete expunges the IMAP copy. A foreign-side disappearance
  does *not* delete the Composition — it clears `imap_draft_uid` and lets the next push re-export it.
  Over IMAP a foreign delete and a foreign edit are indistinguishable, so the asymmetry errs toward
  keeping text the user typed.
- **Switching the sending Mail Account mid-compose** expunges the copy from the old account's `Drafts`
  and lets the next debounce push to the new one — the existing primitives compose into it, with no
  migration path. Attachment blobs are keyed to the Composition, not the account, so they are
  unaffected.
- **Forwarded attachments are materialised, not referenced.** On attach, the part is fetched from IMAP
  and written to the Blob Store, with its size taken from `BODYSTRUCTURE` and checked against the size
  budget *before* the fetch starts. A referenced part would leave the composition non-self-contained
  and able to fail at the last moment.
- **Inline images share the store and the budget,** with a `disposition: inline | attachment` column
  and a generated Content-ID. MIME shape is `multipart/mixed` [ `multipart/related`
  [ `multipart/alternative` [ `text/plain`, `text/html` ], inline parts ], attachments ].
- **Size limits are instance-level config, defaulting to 25MB of encoded message size,** enforced as a
  running budget in the composer and re-checked in the backend, because SMTP servers reject oversized
  mail only after the upload. Base64 inflation means ~25MB encoded is ~18MB of real files. The
  privateemail-specific ceiling is assumed, not verified.
- **Concurrent Mail-side edits reject rather than merge.** Each autosave carries the `version` it
  read; a stale write is rejected and the Client reports that the draft changed on another device.
  Silently overwriting typed text is the one failure worth code to prevent.
- **Lifecycle.** Blobs are deleted once the `Sent` `APPEND` succeeds, and the IMAP draft copy is
  expunged in that same step. Drafts never auto-expire. A sweeper deletes blobs with no parent
  Composition after 24h, catching composers abandoned before the first save.

## Shipping tiers

The design is strictly additive and ships in three tiers. **Tiers 1 and 2 are PoC scope; tier 3 is
deferred to the follow-up map**, since the acceptance bar (14 days off Spark) is not measured on it.

1. **Backend-only drafts** — what `docs/poc-scope.md` actually promised.
2. **+ debounced push, and read-only listing of foreign drafts** in Mail's Drafts view. Full
   portability out of Mail.
3. **+ inbound import and conflict handling.** Deferred. The cost concentrates here:
   MIME→composition import and a conflict state machine.

Tier 3, designed but not built for the PoC: inbound processing keys off the Composition's `version`,
`imap_draft_uid`, and `pushed_content_hash`. Mail changed only → push. IMAP UID changed only →
import in place. Both changed → **fork**: keep Mail's Composition and import the foreign version as a
second one, badging both, so the user resolves it by deleting one. No merge logic. Import loads the
sanitized foreign HTML straight into the editor (the same ingest sanitizer as
`docs/research/0005-html-email-rendering-sanitization.md`, so imports are not a second injection
path), taking `text/plain` as the plaintext alternative when present and accepting that unsupported
constructs normalise. On import the Composition adopts the foreign UID and does not immediately
re-push. Only `draft`-status Compositions accept inbound changes. Inbound detection rides the standard
non-INBOX folder poll — no dedicated `IDLE` connection for the least time-critical folder there is.
