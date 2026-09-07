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
A person signed in to a self-hosted instance. Owns one or more Connected Accounts.
_Avoid_: account (unqualified)

**Connected Account**:
One identity at one Provider that a User has signed in with or entered credentials for, held by the
Sync Backend: a Google account, a Microsoft account, a CalDAV/CardDAV server login, or an Other IMAP
login. Owned by exactly one User, holding exactly one Grant or password, and carrying one or more
Facets. Unique per User, Provider and identity; two Users who connect the same upstream account each
own a separate Connected Account.
_Avoid_: account (unqualified), integration, connection, linked account

**Facet**:
One of the three kinds of data a Connected Account can be connected for: Mail, whose one Facet is
the Mail Account; Calendar, which yields the Connected Account's Calendars; Contacts, which yields
its Address Books. Turned on one at a time, each asking the Provider only for its own consent. The
User sees the three names, never the word.
_Avoid_: service, scope (when the thing rather than the Provider's permission is meant), sync type

**Mail Account**:
The Mail Facet of a Connected Account: its connection to a mail server, using the Connected
Account's credential. At most one per Connected Account, owned by the same one User. Two Users
following the same mailbox each own a separate Connected Account and Mail Account.
_Avoid_: mailbox, inbox, account (unqualified)

**Needs Reauth**:
The state of a Connected Account whose credential the server has rejected or whose Grant the
Provider has withdrawn, or of a single Facet whose consent alone the Provider refuses. Syncing stops
for what is affected (every Facet, or that one) until the User signs in again or supplies new
credentials; mirrored data stays readable and pending Optimistic Actions wait rather than fail.
Always something the User can fix by signing in, never a problem only the Owner can fix.

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
One of the personal-hub products a Client holds: Mail today, with Calendar, Contacts, Tasks and
Notes named and reserved, in that order on the App Switcher. An App is a whole product surface with
its own navigation, not a screen inside Mail — which is why the Client's chrome makes room for five
rather than treating Mail as the whole world. Each App says whether it observes Account Scope and
which of its collections the Local Cache holds whole.
_Avoid_: module, section, tab

**Account Scope**:
Which of the User's Connected Accounts the Client is currently showing: any non-empty subset,
defaulting to all of them. Mail shows the Mail Facets in scope; Calendar and Contacts show the
collections whose Origin is in scope; Local collections are always in scope. Chrome that belongs to
the Client rather than to any App, because narrowing to one account is a question every App
answers. Actions that can only mean one account — sending, or changing a Gatekeeper setting — ask
for that account rather than inheriting the Scope. An App whose data belongs to the User alone
(Notes, Tasks) does not observe the Scope, and the Hub hides the control while it is shown.
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
The Client's own copy of a bounded slice of its mail, holding what the User is actually triaging rather than the whole mailbox, plus the whole of the User's small App collections (Notes, Contacts, Labels) and the Event Window. Deliberately disposable: it can be discarded and rebuilt from the Sync Backend at any time, so it is never a source of truth for anything but rendering, even where it happens to hold everything. Unrelated to the Local Origin, which means this instance rather than the device.
_Avoid_: local store, local database, replica, offline store

**Notifier**:
The part of the Sync Backend that decides whether a change is worth interrupting a User for, and delivers it to their devices. Deliberately separate from syncing: knowing that mail arrived and judging that someone should be told are different jobs.
_Avoid_: push service, notification service

**Sync Hint**:
A message telling a Client that something it holds has changed, carrying no mail state of its own. A Client that receives one pulls the actual changes; a Client that misses one finds them on its next poll, so a hint is always an accelerator and never the only route.
_Avoid_: push event, change event, notification (when the User is not being told anything)

**Sync Scope**:
Whose thing a synced collection is, and therefore what the Client asks for it under: the User
(Preferences, Labels, Notes, Tasks), a Mail Account (Threads, Correspondents), or a Connected
Account (Calendars, Address Books). Every collection declares exactly one, and an App's data joins
the one sync round the Client already runs rather than a channel of its own.
_Avoid_: partition, tenant, namespace

**System Mailer**:
Optional sending credentials the operator configures so the instance can send mail *as itself* (account recovery). Belongs to no User and is never synced or shown as a mailbox.
_Avoid_: system account, admin mailbox

### Providers

**Provider**:
Who runs a Connected Account's server as far as signing in is concerned: Google, Microsoft, Other
IMAP, or CalDAV/CardDAV. Google and Microsoft accounts are added by signing in with the Provider;
the other two by entering a server and credentials. A Connected Account added as Other IMAP may
change Provider to Google by signing in with the same address, keeping everything it holds.
_Avoid_: service, vendor, integration

**Provider Registration**:
The app the Owner has registered with a Provider so this instance may ask Users to sign in with it.
Instance-wide, belongs to no User, and the one thing a Member cannot fix: without it the Provider is
shown as unavailable on this instance.
_Avoid_: OAuth app, client credentials, API keys

**Grant**:
One User's consent for one Connected Account, obtained by signing in with the Provider and held by
the Sync Backend, covering the Facets the User has turned on so far: adding a Facet widens the one
Grant rather than making a second. When a Provider withdraws a Grant, the Connected Account is Needs
Reauth, exactly as for a rejected password.
_Avoid_: token, refresh token, connection

**Provider Health**:
The Owner's view of each Provider Registration, per Facet: whether the Registration exists, whether a
Grant has ever been obtained through it for that Facet, whether those Grants are currently being
honoured, and whether the Provider-side API the Facet needs is enabled on the Registration. A Facet
the Registration cannot serve is shown to Members as unavailable on this instance, never as Needs
Reauth. Part of the instance settings, never of any Connected Account.
_Avoid_: token status, admin health

### Synced data

**Origin**:
Where a Calendar or Address Book comes from: exactly one Connected Account, whose upstream it
mirrors, or Local. Every Event and Contact takes the Origin of its collection and never has one of
its own. Tasks are Local in v1 and carry the same field.
_Avoid_: source, backend, provider (when the collection's home rather than the sign-in is meant)

**Local**:
The Origin of a Calendar or Address Book that lives only on this instance's Sync Backend, with no
upstream: created by the User, never synced, never Needs Reauth. Local means this instance, never
the User's device; the Client's own copy of anything is the Local Cache.
_Avoid_: on-device, offline (for this meaning), Wicket calendar, instance calendar

### Mail concepts

**Folder**:
One mailbox on one Mail Account's mail server, as IMAP presents it. Which folder is Trash or Sent is
the *server's* answer (its special-use flags), recorded once at sync rather than guessed from a name,
because it differs per provider. Distinct from a Label, which is a User's own tag and has no
IMAP-side existence.
_Avoid_: mailbox, directory, IMAP folder

**Gmail Label**:
Gmail's own tag on a message, which IMAP shows as a folder. On a Mail Account whose server is Gmail,
the Inbox, Sent and the User's own Gmail labels are Gmail Labels seen through the one synced Folder
that holds everything, All Mail — not Folders synced in their own right. Browsable, never edited from
Wicket, and never a Wicket Label.
_Avoid_: Gmail folder, label (unqualified, when Gmail's is meant)

**Inbox**:
The Threads on a Mail Account awaiting Triage. On most servers the INBOX Folder; on Gmail, the
Inbox Gmail Label seen through All Mail. Gatekeeper, the Notifier and Done all act on arriving in or
leaving the Inbox, never on which folder the server keeps the message in.
_Avoid_: INBOX (when the concept rather than the IMAP folder is meant), unread, new mail

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
Where a Thread lands once it is Done. A destination, never an action. On Gmail, where nothing is
ever moved, it is All Mail without the Inbox Gmail Label.
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
Reversing a Triage action, a Gatekeeper decision or an App's own action (deleting a Note, deleting
or moving a Contact, importing a file) within a short window after it, from the toast that
announced it. Always a real inverse action (restore to Inbox, unsnooze, unblock and restore, restore
a Note, delete the imported batch), so it
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
Any action on synced data — Triage, a Gatekeeper decision, or an App's own action such as pinning or deleting a Note, or editing a Contact that pushes to its upstream — whose result is shown instantly in the Client while the Sync Backend applies it in the background, rolling back visibly on failure. Durably queued in the Client: it survives a reload, is performable offline, and on Needs Reauth waits indefinitely rather than failing.

**Rollback**:
The Sync Backend undoing an Optimistic Action it could not make stick, either at once (the store
refused it) or later, when a synced collection's upstream refused the write or had already changed.
The affected row visibly reverts and a toast names the action with Retry, on every device the User
has open, however long after the action it happens. Always the system's doing, never the User's:
the User reversing their own action is Undo.
_Avoid_: revert, conflict (unqualified), failed sync

**Auto-advance**:
After archiving or deleting, automatically opening the next thread or returning to the list (User-configurable).

**Reader**:
The surface where one Thread is read and acted on: the pane beside the list on a desktop, the whole
screen on a phone, and the face of each card in Stream. Opening a Thread from the list is one step
the User can take back; moving to another Thread from inside the Reader is not a further step, so
Back always returns to the list, however many Threads were read in between.
_Avoid_: detail view, reading mode, mail detail, thread view

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
Keeping a Thread or a Note prominently visible regardless of its age. An App Feature, and deliberately not the same thing as a Star: a Star says "this matters", a Pin says "keep this in front of me".

**Label**:
A user-defined tag a User applies to a Thread, a Note or a Contact for organization. Owned by the User, not by any one Mail Account, so one set of Labels spans all of a User's Mail Accounts, their Notes and their Contacts. An App Feature: stored only in the Sync Backend, independent of any Mail Account's provider-native folder or keyword representation (e.g. Gmail's IMAP folder-labels) and never written to an upstream address book's groups, which are shown on a Contact read-only.
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
An address the User has actually exchanged mail with on a Mail Account, derived from message history and never hand-edited. The source of recipient suggestions while composing, ranked by how recently and how often mail was exchanged; a Contact whose address is also a Correspondent keeps that rank and lends it a name and photo. Shown in the Contacts App as People You've Mailed until it is saved as a Contact.
_Avoid_: contact (reserved for the address-book entries a User manages), recipient

### Contacts

**Address Book**:
One Origin's collection of Contacts: a Connected Account's address book mirrored through its
Contacts Facet, or the User's one Local Address Book. Discovered from the upstream, never created,
renamed or deleted upstream by Wicket, which manages the Contacts inside it. The Contacts App shows
one list across every Address Book in Account Scope, with the Address Book as a filter, never as a
separate screen.
_Avoid_: contact list, contact folder, group

**Contact**:
A person or organisation the User keeps in an Address Book: names, emails, phones, addresses,
organisations, birthday, websites, notes, photo, Labels and Custom Fields. Holds exactly the fields
its Origin can hold, so everything on a synced Contact round-trips to its upstream; the Local
Address Book holds the whole set. Identified by Wicket, never by its upstream's id. Distinct from a
Correspondent, which is derived and never edited.
_Avoid_: person (unqualified), entry, card (for the record rather than the rendering)

**Default Address Book**:
The Address Book a new Contact lands in when the User saves one without choosing: promoting a
Correspondent, saving a sender from the Reader or Screener, importing a file. Local until the User
picks another in Settings; every save sheet lets it be overridden once.
_Avoid_: primary address book, main account

**Person Page**:
Where one Contact is read and edited, and where the mail history of every address on it is shown
across Account Scope. That history is a search run for the Contact's addresses, bounded like any
other, never a stored link between Contact and Thread. The Contact's photo, when it has one, is the
avatar wherever that address appears in Mail.
_Avoid_: contact detail, profile, contact view

**Linked Contacts**:
Two or more Contacts in different Address Books that the User has said are one person. Shown as one
card and one Person Page whose fields are the union, each field staying in the record it came from
and edited there; the record in the Default Address Book fronts the card unless the User picks
another. Never merged across Origins, because two upstreams cannot hold each other's fields.
Suggested on a shared email address or phone number, never linked automatically.
_Avoid_: merged contact, unified contact, duplicate (for the linked pair)

**Merge**:
Combining two Contacts of the same Address Book into one: the older record survives and takes the
other's fields, the other is deleted. Only offered within one Address Book; across Address Books the
answer is Linked Contacts.
_Avoid_: combine, dedupe, join

**Custom Field**:
A labelled, typed value the User adds to a Contact beyond the fixed families: text, date, number,
phone, location or website. A standard value whose label falls outside the fixed vocabulary (a phone
labelled "Boat", an anniversary) is a Custom Field of that type. Offered only where the Contact's
Origin can hold it.
_Avoid_: extra field, user-defined field, X- property

**People You've Mailed**:
The Contacts App filter listing the Correspondents from every Mail Account in Account Scope whose
address is on no Contact, ranked as compose ranks them, each with Save. The one door from
Correspondents into Contacts, and a filter on the one list rather than a second list.
_Avoid_: suggestions, other contacts, recent people

### Notes

**Note**:
A rich-text document a User writes and keeps for themselves: a tree of blocks (headings, lists,
checklists, tables, code, a Thread Link) with no separate title — the first block is the title. Owned
by the User, never synced upstream, never shared. Sorted by when it was last edited, shown whole in
the Local Cache, and edited where it is read: there is no separate reading mode.
_Avoid_: page, document, memo

**Thread Link**:
A block inside a Note that stands for one Thread — its subject, participants and date — and opens
that Thread in Mail. The one way mail enters a Note: "Add to Notes" on a Thread creates a Note
titled with the subject whose first block is a Thread Link; the mail itself is never copied in.
_Avoid_: mail embed, quote, attachment

**Recently Deleted**:
Where a deleted Note or Contact waits for thirty days before it is gone: a view of the Notes App or
the Contacts App showing the same cards greyed, each with Restore. Deleting is an Optimistic Action
with Restore as its Undo, so the toast and this view are two doors to the same inverse. A synced
Contact is removed from its upstream at once and kept here as Wicket's copy; Restore creates it
upstream again as a new record. Only deletions made in Wicket land here; a Contact deleted upstream
simply disappears, because the mirror follows the upstream.
_Avoid_: trash (reserved for mail), bin, archive

### Calendar

**Calendar**:
One named collection of Events with exactly one Origin: a Connected Account's upstream calendar
mirrored whole, or a Local calendar this instance is the authority for. Its name, description and
time zone are the upstream's where it has one; its colour and whether it is shown are the User's own
and never leave Wicket. Every User has a Local Calendar from the first use of the App, and one
Calendar across all Origins is the User's default for new Events, the Local one until they choose
otherwise. A Calendar the upstream grants only reading of is shown and never offers editing.
_Avoid_: agenda, calendar feed, subscription

**Event**:
What the User sees on the grid: one dated thing with a title, a time or a whole day, on one
Calendar. The word for every Occurrence, recurring or not, in UI copy; the User is never asked to
think in Series unless they choose an edit scope.
_Avoid_: appointment, meeting (unless attendees are meant), entry, item

**Series**:
The unit a Calendar actually holds and syncs: one Event body plus, when it repeats, its recurrence
rule, extra dates and removed dates in RFC 5545 form. A non-repeating Event is a Series with no rule
and exactly one Occurrence, so there is one shape for everything. Identified by a Wicket id, and
carrying the upstream's id, iCalendar `UID` and revision beside it.
_Avoid_: recurring event, master, parent event

**Occurrence**:
One dated instance derived from a Series by the Sync Backend, keyed by the Series and the instance's
original start. What the Client receives and renders; the Client never expands a rule itself. A
removed Occurrence is only a date the Series no longer happens on, with nothing else remembered,
because the poorest upstream cannot supply more.
_Avoid_: instance, expanded event

**Override**:
An Occurrence whose fields differ from its Series because the User or the upstream changed that one
instance, iCalendar's `RECURRENCE-ID` exception. Editing "this event" makes one; editing "this and
following" splits the Series in two instead; editing "all events" changes the Series itself.
_Avoid_: exception, modified instance, detached event

**Organiser**:
The address that owns an Event's invitations: the one whose changes attendees follow. On a Local
Calendar it is the User, and the Sync Backend is its authority; on a synced Calendar it is whoever
the upstream says. Marked as the User's own when it matches a Connected Account's identity, a Mail
Account's address or an Alias.
_Avoid_: owner, host, creator

**Attendee**:
An address invited to an Event, with a role (required, optional, or a room or resource) and an
answer (no answer yet, accepted, tentative, declined), held on the Event itself rather than as a
link to a Contact; any Contact or Correspondent with the same address is found at display time.
One Attendee is marked as the User's own, the one whose answer the User can change.
_Avoid_: guest, participant, invitee, recipient

**Reminder**:
A number of minutes before an Event's start at which the User is told about it. Held per Event,
or inherited from the Calendar's defaults when the Event asks for those; delivery is the Notifier's
job. Reminders that send email or fire at an absolute time are kept for round-tripping and never
shown or fired.
_Avoid_: alarm, alert, notification (when the setting rather than the delivery is meant)

**Materialisation Window**:
The span of time, about a year back and two years forward from today and rolling daily, for which
the Sync Backend keeps every Series expanded into stored Occurrences. Outside it, Occurrences are
computed on request and not kept. A Series that never ends is expanded to the edge, never
enumerated.
_Avoid_: expansion range, horizon

**Event Window**:
The slice of the Materialisation Window a Client's Local Cache holds and syncs, about three months
back and a year forward from today, rolling daily. The Calendar's Candidate Window: the span the
User actually lives in, rendered instantly and edited offline; any range outside it is fetched on
demand and shown with a note that older Events load on request.
_Avoid_: sync window, cache range, visible range

### Search

**Command Palette**:
The Client's one place to type. Opened from the Hub's search pill, from `/` or from ⌘K, it answers
what the User types with commands, mail hits and App hits in a single list — commands first whenever
the words match one, mail hits beneath, then hits from the App collections the Local Cache holds
whole (Notes, Contacts), found locally. It is the only way a search starts, and "See all results" is
the only way from it into the full result list; an App's own chips and sections are filters on a
view, never a second place to type. Client chrome, present over every App and every screen,
including Stream.
_Avoid_: search box, search bar, omnibar, quick switcher

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
