# Mail (working title)

A fast, modern, self-hosted email client: a companion Sync Backend that talks to the user's existing mail servers, and speed-obsessed Clients that talk only to the Sync Backend.

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

**Local Cache**:
The Client's own copy of a bounded slice of its mail, holding what the User is actually triaging rather than the whole mailbox. Deliberately disposable: it can be discarded and rebuilt from the Sync Backend at any time, so it is never a replica and never a source of truth for anything but rendering.
_Avoid_: local store, local database, replica, offline store

**System Mailer**:
Optional sending credentials the operator configures so the instance can send mail *as itself* (account recovery). Belongs to no User and is never synced or shown as a mailbox.
_Avoid_: system account, admin mailbox

### Mail concepts

**Thread**:
A conversation: the unit the message list shows and most actions target.
_Avoid_: conversation

**Triage**:
Processing the message list: archive, trash, pin, snooze, label, approve/block senders.

**Protocol Feature**:
Triage state stored as a real IMAP flag or folder operation, visible to any other IMAP client against the same Mail Account. Reserved for the rare case where a clean, near-universal mapping exists across the PoC's target providers — currently just read/unread (`\Seen`) and starred (`\Flagged`).
_Avoid_: IMAP-native

**App Feature**:
Triage state stored only in the Sync Backend, with no IMAP-side trace — the default for new state. Pin, Label, Snooze, and Gatekeeper verdicts are App Features.
_Avoid_: backend-only, local-only

**Optimistic Action**:
Any Triage action whose result is shown instantly in the Client while the Sync Backend applies it in the background, rolling back visibly on failure. Durably queued in the Client: it survives a reload, is performable offline, and on Needs Reauth waits indefinitely rather than failing.

**Auto-advance**:
After archiving or deleting, automatically opening the next thread or returning to the list (User-configurable).

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
Where a sender stands with Gatekeeper on one Mail Account: Unscreened, Approved, or Blocked. Keyed to a sender's address, or to a whole domain.

**Unscreened Sender**:
A sender the User has not yet approved or blocked.

**Approved Sender**:
A sender the User has let through: their mail lands normally, and their remote images load without asking.
_Avoid_: whitelisted

**Blocked Sender**:
A sender the User has denied for good: the Sync Backend moves their incoming mail straight to Trash on arrival.
_Avoid_: blacklisted

**Screener**:
The separate screen where held mail waits, listing Unscreened Senders rather than individual messages — one decision per stranger, not per message.

**Screening Hold**:
The state of mail waiting in the Screener. An App Feature, with no IMAP-side trace.
_Avoid_: quarantine

**Gatekeeper Cutoff**:
The moment Gatekeeper was switched on for a Mail Account. Only mail arriving after it is ever screened; everything already in the mailbox is grandfathered.

### Sending

**Composition**:
The content of a message being written: recipients, subject, body, and its attachments. A Draft and a Pending Send are two states of one Composition, never separate things, so cancelling a send changes a status rather than copying content.

**Draft**:
A Composition the User is still writing. An App Feature — the Sync Backend holds the authoritative copy — that is also exported to the Mail Account's IMAP `Drafts` folder so other mail clients can read and finish it.

**Undo Send**:
A configurable per-User delay between pressing send and actual submission, during which the send can be cancelled.

**Pending Send**:
The state of a Composition from the moment a send is accepted until it is submitted or cancelled. Owned by the backend, not the Client, so it survives the Client closing and is visible on every device the User has open. Cancelling returns it to a Draft.
_Avoid_: outbox, queued mail

### Preferences

**Device Preference**:
A setting that deliberately never syncs, because it means something different on each device the User signs in from — layout and list density. Distinct from the User-scoped and Mail-Account-scoped preferences, which do sync and are the same everywhere.
_Avoid_: local setting, client setting
