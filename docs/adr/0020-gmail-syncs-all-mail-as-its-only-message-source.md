# Gmail syncs All Mail as its only message source

On a Mail Account whose server advertises Gmail's IMAP extension (`X-GM-EXT-1`), the Sync Backend
syncs `[Gmail]/All Mail`, Spam, Trash and Drafts as Folders and **nothing else**. The Inbox, Sent and
the User's own Gmail labels are not synced as Folders: they are **Gmail Labels** read per message
from All Mail (`X-GM-LABELS`) and projected onto Threads. Done removes the Inbox Gmail Label instead
of moving anything, so Archive on Gmail is "All Mail without the Inbox label" (see `CONTEXT.md`:
Inbox, Gmail Label, Archive). Decided in the #91 grilling, 2026-09-04.

Gmail presents every label as an IMAP folder and keeps every message in All Mail as well, so a
per-folder sync of a fifteen-year archive stores each message once per label it carries, and has
no `\Archive` folder for Done to move into — today's `archive` intent is rejected outright with
`no_archive_folder` on Gmail. The scale bar in `docs/poc-scope.md` exists precisely for this
archive, so the duplication is not a rounding error.

## Considered Options

- **Plain per-folder IMAP, as for every other server**: rejected — two to five copies of the
  archive, a Thread reader that shows the same message twice (the thread read model has no
  Message-ID dedupe, by design: two Folders means two Messages), and an Archive that has to be
  faked as "move from INBOX to All Mail".
- **Sync folders but collapse rows by `X-GM-MSGID`**: rejected — redefines Message ("one message
  in one Folder, identified by folder and UID") for one Provider, and every consumer of the
  natural key `(folderId, uid)` would need a second identity to reason about.
- **Adopt Gmail's own threads (`X-GM-THRID`)** while we were at it: rejected — Gmail threads by
  subject as well as headers, and Wicket threads from the header chain only because a wrongly
  merged conversation is harder to recover from than a split one. One threading rule across
  Providers.

## Consequences

- **Selection is by server capability, not by credential kind.** A Gmail account added with an app
  password through "Other IMAP" gets the same model as one added by signing in with Google
  ([ADR-0021](0021-provider-registration-is-per-instance-and-owner-entered.md)). The detected kind
  is recorded on the Mail Account at verification so write paths can branch without a live
  connection.
- **"Inbox" becomes a concept, not a folder role.** Gatekeeper screening and blocking, the
  Notifier's new-mail policy, Done and Undo all key off arriving in or leaving the Inbox, whether
  that is the INBOX Folder or the Inbox Gmail Label. The IDLE watch moves to All Mail on Gmail,
  since new mail lands there at the same instant.
- **Triage writes gain a second shape.** Done and restore-to-Inbox on Gmail are `X-GM-LABELS`
  removes and adds on the All Mail UID, not `UID MOVE`s; Trash and Spam remain real moves, and
  Gmail drops a moved message from All Mail on its own.
- **Gmail Labels get their own wire collection and sidebar section**, browsable and read-only,
  never merged into the Label collection: a Gmail Label is never a Wicket Label
  (`CONTEXT.md`). Threads carry Gmail Label ids alongside Label ids. `\Sent` supplies "this Thread
  has a sent message"; `\Starred` is already Star via `\Flagged`; Important, the Categories and
  Chats are ignored and never shown.
- **The Sent append is skipped on Gmail.** Gmail files SMTP-submitted mail into Sent itself; a
  second APPEND risks a duplicate that Gmail may or may not collapse. The Composition record keeps
  the Bcc list the server copy lacks. Other Providers keep the append until a live test shows the
  same behaviour (open item for Outlook.com).
- **Drafts are excluded from All Mail ingest** (they carry `\Draft` there too); the Drafts Folder is
  synced in its own right, as today, so the draft-push loop is unchanged.
- **Gmail's daily IMAP download cap (about 2.5 GB) pauses the body sweep rather than failing it.**
  The Index Watermark already states partial coverage, so a paused sweep is expected behaviour,
  not a sync error.
- **The schema comment that a Gmail label legitimately yields a second Message row is now wrong
  for Gmail** and should be reworded when the model lands; a Sent self-copy on a non-Gmail server
  remains the valid example.
