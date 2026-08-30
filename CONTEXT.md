# Mail (working title)

A fast, modern, self-hosted email client: a companion Sync Backend that talks to the user's existing mail servers, and speed-obsessed Clients that talk only to the Sync Backend.

## Language

### People & accounts

**User**:
A person signed in to a self-hosted instance. Owns one or more Mail Accounts.
_Avoid_: account (unqualified)

**Mail Account**:
A connection to an external mail server (credentials + settings) owned by a User.
_Avoid_: mailbox, inbox, account (unqualified)

### System parts

**Sync Backend**:
The self-hosted server component that syncs Mail Accounts with their mail servers, holds the fast local store, and serves all Clients.
_Avoid_: proxy, bridge, API server

**Client**:
Any UI (web/PWA now, native later) that talks exclusively to the Sync Backend, never to a mail server directly.

### Mail concepts

**Thread**:
A conversation: the unit the message list shows and most actions target.
_Avoid_: conversation

**Triage**:
Processing the message list: archive, trash, pin, snooze, label, approve/block senders.

**Optimistic Action**:
Any Triage action whose result is shown instantly in the Client while the Sync Backend applies it in the background, rolling back visibly on failure.

**Auto-advance**:
After archiving or deleting, automatically opening the next thread or returning to the list (User-configurable).

**Snooze**:
Hiding a thread until a chosen time, after which it returns as new.

**Pin**:
Keeping a thread prominently visible regardless of its age.

### Gatekeeper

**Gatekeeper**:
The screening feature: mail from Unscreened Senders is held in a dedicated space and highlighted until the User decides.

**Unscreened Sender**:
A sender the User has not yet approved or blocked.

**Approved Sender**:
A sender the User has let through; their mail lands normally.
_Avoid_: whitelisted

**Blocked Sender**:
A sender the User has denied; their mail is kept out of sight.
_Avoid_: blacklisted

### Sending

**Undo Send**:
A configurable delay between pressing send and actual submission, during which the send can be cancelled.
