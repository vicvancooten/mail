# Wicket

A fast, modern, self-hosted email client: a companion Sync Backend that talks to the user's existing mail servers, and speed-obsessed Clients that talk only to the Sync Backend.

Named for the post-office service window, and for the small gate beside a large one that people
pass through single file — both readings are Gatekeeper. The visual system ("The Instrument") is
`apps/client/DESIGN.md`, generated from the shipped result, against the approved comp at
`docs/design/prototypes/the-instrument.html`; the terms below remain binding in UI copy regardless
of it. (`docs/design/wicket-identity.html` is the prior identity, superseded and kept as history.)

## Language

### People & accounts

**User**:
A person signed in to a self-hosted instance. Owns one or more Mail Accounts.
_Avoid_: account (unqualified)

**Mail Account**:
A connection to an external mail server (credentials + settings) owned by exactly one User. Two Users following the same mailbox each own a separate Mail Account.
_Avoid_: mailbox, inbox, account (unqualified)

**Needs Reauth**:
The state of a Mail Account whose stored credentials the mail server has rejected: syncing stops until the User supplies new credentials, and pending Optimistic Actions wait rather than fail.

**Owner**:
The User who set up the instance: the only role that can invite other Users and change instance settings.
_Avoid_: admin, superuser

**Member**:
A User who is not the Owner: full control of their own Mail Accounts, no say over the instance.

### System parts

**Sync Backend**:
The self-hosted server component that syncs Mail Accounts with their mail servers, holds the authoritative store of all mail and Triage state, and serves all Clients.
_Avoid_: proxy, bridge, API server

**Client**:
Any UI (web/PWA now, native later) that talks exclusively to the Sync Backend, never to a mail server directly.

**App**:
One of the personal-hub products a Client holds: Mail today, with Contacts, Calendar and Tasks
named and reserved. An App is a whole product surface with its own navigation, not a screen inside
Mail — which is why the Client's chrome makes room for four rather than treating Mail as the whole
world.
_Avoid_: module, section, tab

**Account Scope**:
Which of the User's Mail Accounts the Client is currently showing: any non-empty subset, defaulting
to all of them. Chrome that belongs to the Client rather than to Mail, because narrowing to one
account is a question every App answers. Actions that can only mean one account — sending, or
changing a Gatekeeper setting — ask for that account rather than inheriting the Scope.
_Avoid_: account switcher, unified inbox, active account

**App Switcher**:
The Client chrome that moves the User between Apps and names the ones not yet built. Reserved Apps
are shown and marked unavailable rather than hidden, because the Client's shape is a promise about
what the instance will hold.
_Avoid_: app rail, nav bar

**Hub**:
The Client's own chrome: the bar holding the App Switcher, the home mark, search, Account Scope,
appearance and the User's menu. It belongs to no App and is present on every screen. The current
App sits on it as a raised card, and the browser's own chrome takes the Hub's colour, so the frame
reads as one continuous piece rather than a bar inside a page.
_Avoid_: header, top bar, nav bar

**Local Cache**:
The Client's own copy of a bounded slice of its mail, holding what the User is actually triaging rather than the whole mailbox. Deliberately disposable: it can be discarded and rebuilt from the Sync Backend at any time, so it is never a replica and never a source of truth for anything but rendering.
_Avoid_: local store, local database, replica, offline store

**Notifier**:
The part of the Sync Backend that decides whether a change is worth interrupting a User for, and delivers it to their devices. Deliberately separate from syncing: knowing that mail arrived and judging that someone should be told are different jobs.
_Avoid_: push service, notification service

**Sync Hint**:
A message telling a Client that something it holds has changed, carrying no mail state of its own. A Client that receives one pulls the actual changes; a Client that misses one finds them on its next poll, so a hint is always an accelerator and never the only route.
_Avoid_: push event, change event, notification (when the User is not being told anything)

**System Mailer**:
Optional sending credentials the operator configures so the instance can send mail *as itself* (account recovery). Belongs to no User and is never synced or shown as a mailbox.
_Avoid_: system account, admin mailbox

### Mail concepts

**Folder**:
One mailbox on one Mail Account's mail server, as IMAP presents it. Which folder is Trash or Sent is
the *server's* answer (its special-use flags), recorded once at sync rather than guessed from a name,
because it differs per provider. Distinct from a Label, which is a User's own tag and has no
IMAP-side existence.
_Avoid_: mailbox, directory, IMAP folder

**Message**:
One message as it exists in one Folder — IMAP's own unit, identified by its folder and UID. The same
message present in two Folders (a Sent self-copy) is two Messages that thread into one Thread.
_Avoid_: email, mail item

**Thread**:
A conversation: the unit the message list shows and most actions target. Assembled from the
`Message-ID`/`In-Reply-To`/`References` chain only — never from matching subjects, because a wrongly
merged conversation is far harder to recover from than a split one.
_Avoid_: conversation

**Triage**:
Processing the message list: Done, trash, pin, snooze, label, approve/block senders.

**Done**:
Clearing a Thread out of the Inbox: the primary Triage action and the verb the UI uses on The
Instrument (#66, #75), framed as finishing work rather than filing it. What it *does* is move the
Thread to the Archive — Done is the act, Archive is the place it lands, and the two names are never
swapped.
_Avoid_: archive (as a verb), clear, dismiss

**Archive**:
Where a Thread lands once it is Done. A destination, never an action.
_Avoid_: archive (as a verb), done (as a place)

**Time Group**:
A run of Threads in the message list that share a recency bucket — Pinned, Today, Yesterday, This
week, Last week, This month, earlier months, Older, Undated — each with its own header. The list's
only grouping; Threads are never grouped by sender or kind.
_Avoid_: category, section, date group

**Group Done**:
Marking every Thread in one Time Group as Done in a single action, from the check control on that
group's header. The control is the same "check means Done" glyph a hovered Thread row shows, grown
to sit beside the group's title; it is an action, never a selection — nothing in the list is ever
"selected" by a checkbox.
_Avoid_: bulk select, select all, check all

**Timeline Spine**:
The vertical line that appears down the list's left gutter, from a Time Group's header through
every row it covers, only while the pointer rests on that group's Group Done control. It exists to
say "this is about to happen to all of these" before it does.
_Avoid_: timeline, rail, gutter line

**Undo**:
Reversing a Triage action or Gatekeeper decision within a short window after it, from the toast that
announced it. Always a real inverse action (restore to Inbox, unsnooze, unblock and restore), so it
works whether or not the Sync Backend has already applied the original; never a cancellation of a
queued request. Actions taken in quick succession share one toast and one Undo.
_Avoid_: revert, rollback (which is the Sync Backend rejecting an action, not the User reversing one)

**Protocol Feature**:
Triage state stored as a real IMAP flag or folder operation, visible to any other IMAP client against the same Mail Account. Reserved for the rare case where a clean, near-universal mapping exists across the PoC's target providers — currently just read/unread (`\Seen`) and starred (`\Flagged`).
_Avoid_: IMAP-native

**App Feature**:
Triage state stored only in the Sync Backend, with no IMAP-side trace — the default for new state. Pin, Label, Snooze, and Gatekeeper verdicts are App Features.
_Avoid_: backend-only, local-only

**Snippet**:
The short plain-text opening of a message, with quoted and forwarded history stripped, used wherever a message is previewed rather than read. Derived once when the message is first stored, so every surface that previews it shows the same words.
_Avoid_: preview, excerpt, teaser

**Optimistic Action**:
Any Triage action whose result is shown instantly in the Client while the Sync Backend applies it in the background, rolling back visibly on failure. Durably queued in the Client: it survives a reload, is performable offline, and on Needs Reauth waits indefinitely rather than failing.

**Auto-advance**:
After archiving or deleting, automatically opening the next thread or returning to the list (User-configurable).

**Stream**:
Processing the Inbox one Thread at a time, full screen, as a stack of cards: the newest Thread on
top with the next one peeking out behind it, the Triage actions plus Skip laid out plainly, and
each action moving the stack on. A way of working through what is unhandled, not a way of looking
at the list: it is entered deliberately from Mail, ends when the stack is empty or the User leaves,
and remembers nothing about layout. Skip leaves the Thread in the Inbox and moves on.
_Avoid_: stream mode (as a view mode), reading mode, focus mode

**Snooze**:
Hiding a thread until a chosen time, after which it returns as new.

**Star**:
Marking a Thread as important using the mail server's own `\Flagged` state. A Protocol Feature, so it round-trips to every other IMAP client — the User's existing stars are there on first sync.
_Avoid_: flag, favourite, bookmark

**Pin**:
Keeping a thread prominently visible regardless of its age. An App Feature, and deliberately not the same thing as a Star: a Star says "this matters", a Pin says "keep this in front of me".

**Label**:
A user-defined tag a User applies to a Thread for organization. An App Feature: stored only in the Sync Backend, independent of any Mail Account's provider-native folder or keyword representation (e.g. Gmail's IMAP folder-labels).
_Avoid_: tag, IMAP keyword

### Gatekeeper

**Gatekeeper**:
The screening feature: mail from Unscreened Senders is held in the Screener until the User decides. A triage control, not a security control — spam and forgery remain the mail server's job. Opt-in per Mail Account, and Verdicts are scoped to a single Mail Account, so they never cross Users or a User's other accounts.

**Verdict**:
Where a sender stands with Gatekeeper on one Mail Account: Unscreened, Approved, or Blocked. Keyed to
a sender's address, to a sender's whole domain, or — for Blocked only — to an Alias of the User's
own that the mail arrived at. A sender's address beats their domain; a Blocked Alias beats both,
because the Alias itself is what the User has given up on.

**Unscreened Sender**:
A sender the User has not yet approved or blocked.

**Approved Sender**:
A sender the User has let through: their mail lands normally, and their remote images load without asking.
_Avoid_: whitelisted

**Blocked Sender**:
A sender the User has denied for good: the Sync Backend moves their incoming mail straight to Trash on arrival.
_Avoid_: blacklisted

**Spam**:
A Gatekeeper decision that Blocks the sender and, in addition, moves their mail to the Mail
Account's Junk Folder rather than Trash, so the mail server's own filter learns from it. The one
decision that deliberately speaks to the provider's spam filter; a plain Block never does, because
"I don't want this" and "this is spam" are different claims.
_Avoid_: junk (as a verb), report

**Alias**:
An address at a domain the User controls that mail can arrive at without being set up first — a
catch-all address such as somecompany@theirdomain. Wicket learns an Alias from the mail that
reaches it; it is never configured.
_Avoid_: catch-all, plus address, recipient

**Blocked Alias**:
An Alias the User has given up on, usually because it leaked: mail arriving at it is moved straight
to Trash regardless of who sent it, including Approved Senders. A Blocked Verdict keyed to the
recipient rather than the sender, and the only Verdict that is.
_Avoid_: blocked recipient, dead address

**Screener**:
The separate screen where held mail waits, listing Unscreened Senders rather than individual messages — one decision per stranger, not per message.

**Screening Hold**:
The state of mail waiting in the Screener. An App Feature, with no IMAP-side trace.
_Avoid_: quarantine

**Gatekeeper Cutoff**:
The moment Gatekeeper was switched on for a Mail Account. Only mail arriving after it is ever screened; everything already in the mailbox is grandfathered.

### Sending

**Composition**:
The content of a message being written: recipients, subject, body, and its attachments. A Draft and a Pending Send are two states of one Composition, never separate things, so cancelling a send changes a status rather than copying content. Held as a structured document rather than as the HTML that will be sent, so reopening it never degrades what the User wrote.

**Draft**:
A Composition the User is still writing. An App Feature — the Sync Backend holds the authoritative copy — that is also exported to the Mail Account's IMAP `Drafts` folder so other mail clients can read and finish it.

**Quoted Original**:
The earlier message carried into a reply or forward, kept exactly as it arrived rather than re-written into the User's own formatting. Part of a Composition, but never authored by the User.
_Avoid_: quote block, citation

**Undo Send**:
A configurable per-User delay between pressing send and actual submission, during which the send can be cancelled.

**Pending Send**:
The state of a Composition from the moment a send is accepted until it is submitted or cancelled. Owned by the backend, not the Client, so it survives the Client closing and is visible on every device the User has open. Cancelling returns it to a Draft.
_Avoid_: outbox, queued mail

**Correspondent**:
An address the User has actually exchanged mail with on a Mail Account, derived from message history and never hand-edited. The source of recipient suggestions while composing.
_Avoid_: contact (reserved for the address-book entries a User manages), recipient

### Search

**Search Index**:
The Sync Backend's searchable projection of every message — subject, participants, body text and attachment filenames — kept beside the messages themselves and rebuilt in the background whenever the way text is analysed changes. Search runs against it, never against a full index in the Client.
_Avoid_: FTS table, tsvector

**Candidate Window**:
The slice of newest matching messages a search actually ranks, rather than ranking every match across the whole history. Bounding it is what keeps search fast on a fifteen-year mailbox, and it is why an old, strong match can sit behind a recent, weaker one until the User asks for older results. Search runs across the User's Account Scope, and each in-scope Mail Account contributes its own Candidate Window, merged and re-ranked, so one chatty account never crowds a quiet one out.

**Index Watermark**:
How far back a Mail Account's message bodies have been fetched and indexed. Headers are searchable from the first sync; bodies fill in behind a background sweep that runs once and then stops, and the watermark is what the Client shows so partial coverage is stated rather than silently returning too few results.
_Avoid_: backfill progress

### Preferences

**Device Preference**:
A setting that deliberately never syncs, because it means something different on each device the User signs in from — layout, list density, and appearance (light/dark/system; defaults to system; #72, ADR-0011 amended). Distinct from the User-scoped and Mail-Account-scoped preferences, which do sync and are the same everywhere.
_Avoid_: local setting, client setting
