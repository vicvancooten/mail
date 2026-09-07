# Invitations route by the address they arrive at

Calendar invitations ([#158](https://github.com/vicvancooten/mail/issues/158)) have to work for
synced Calendars, whose upstream sends and receives scheduling mail itself, and for Local Calendars,
where the Sync Backend is the organiser's authority and nothing but the User's own Mail Accounts can
carry the mail. The research in
[docs/research/0008-calendar-invites-over-email.md](../research/0008-calendar-invites-over-email.md)
showed that an iMIP `REPLY` travels to whatever mailbox `ORGANIZER` names, that Google and Microsoft
each force sender and organiser to be the same identity, and that nothing on the wire authenticates
an organiser who differs from the From address. We decided that **the address an Invitation arrives
at, or is sent from, decides everything**: it picks the Calendar an Invitation lands on, the path an
Answer travels by, and the identity a Local Calendar organises as. Decided in the #169 grilling,
2026-09-07.

## The rule

- **Every Local Calendar has one Mail Account** (none while the User has none). Its address is the
  Organiser of Events created there, `ORGANIZER` and the SMTP From are always that same address, and
  never an Alias. Several Local Calendars may share one Mail Account. The Personal Calendar takes the
  User's first Mail Account and follows when one is added later.
- **Synced first, Local fallback.** An Invitation whose invited address belongs to a Connected
  Account with a Calendar Facet is the upstream's: the mirror shows the Event, the Answer is an Event
  edit the upstream turns into its own `REPLY`, and the card offers no Calendar choice. Otherwise
  (Other IMAP, a Google account with only the Mail Facet, an Alias) the Invitation lands on the
  Local Calendar matched to that Mail Account, the card lets the User pick any other Local Calendar
  before answering, and the Sync Backend sends an iMIP `REPLY` through the Mail Account matching the
  invited address, with the `ATTENDEE` mailto verbatim even when that is an Alias.
- **Fallback applies whenever the upstream does not have it**: if the mirror lacks the Event after an
  immediate poll (poll lag, or Google's "add invitations to my calendar" setting keeping an unknown
  sender off the calendar), the Local path is used.
- **An Invitation addressed to nobody the User is** (a forwarded invite) offers only "Add to
  calendar", a private copy on the default Calendar; Wicket never answers as an address the User
  does not own.
- **Answers that arrive for Events the User organises are processed, marked Done and notified**:
  the Attendee's Answer updates, the Thread leaves the Inbox, and the Notifier tells the User (toast
  when a Client is open, Web Push otherwise, coalesced per Event), opening the Event. Updates,
  cancellations and unmatched Answers stay in the Inbox.

## Considered Options

- **A single per-User "invitations Calendar"** that every arriving Invitation lands on regardless of
  address: rejected. It breaks the tie between the mailbox that receives the `REQUEST` and the one
  that must send the `REPLY`, and it puts Events a Google account already holds on a second Calendar.
- **Importing fallback Invitations into the synced Calendar** (Google `events.import`, a CalDAV
  `PUT`) so every Invitation for a Connected Account lives upstream: deferred, not rejected. Google's
  own docs say an imported copy may have its response reset, and nothing documents whether it is
  answerable; the Local fallback covers every backend with one path. Revisit if the fallback proves
  annoying.
- **Answering from an Alias as From**: rejected. Compose only sends as the Mail Account's own address,
  SMTP servers may refuse an unconfigured From, and RFC 6047 frames a From that differs from the
  scheduled identity as the shape of spoofing. The Alias stays in `ATTENDEE`, where the organiser's
  matching needs it.
- **Letting the User choose a synced Calendar as the landing target**: rejected. An upstream can
  only hold an invitation addressed to its own identity, and moving an invited Event off a Google
  calendar may be read as a decline.
- **Client-side detection of the `text/calendar` part**: rejected. TNEF unwrapping, RFC 5546 ordering
  across a Thread and matching `REPLY`s to Local Series all run on the Sync Backend, and the Client
  never parses iCalendar (ADR-0025).

## Consequences

- The Sync Backend parses every ingested Message once for `text/calendar` parts with a `method`
  (any depth, inner `METHOD` wins, TNEF unwrapped) and stores an **Invitation** row beside the
  Message with method, `UID`, `RECURRENCE-ID`, `SEQUENCE`, `DTSTAMP`, organiser, attendees and the
  parsed VEVENT. Revisions of one `UID` in a Thread are ordered by `SEQUENCE` then `DTSTAMP`.
- An Invitation from an Approved sender creates its fallback Event on arrival as "no answer yet",
  with no Reminders until answered; an Unscreened sender's Invitation renders its card in the
  Screener and creates the Event only when the sender is approved; Blocked senders never touch a
  Calendar.
- **Undo of an Answer is a real inverse ([ADR-0019](0019-undo-is-an-inverse-action-not-a-queue-cancellation.md))**:
  on a Local Calendar the `REPLY` is held for the User's Undo Send delay
  ([ADR-0007](0007-undo-send-is-a-backend-held-pending-send.md)) and Undo cancels it; on a synced
  Calendar Undo sets the previous Answer where the upstream can express it, and the toast offers no
  Undo for a first Answer where it cannot (Graph has no un-respond; RFC 5546 has no `NEEDS-ACTION`
  reply). Changing an Answer later is always a new `REPLY`.
- Organiser-side sending on a Local Calendar: create sends `REQUEST` at once; an edit touching time,
  recurrence, location, title, description or attendees prompts Send / Don't send; an added Attendee
  gets `REQUEST` alone, a removed one `CANCEL` alone; deleting the Event or one Occurrence sends
  `CANCEL` (with `RECURRENCE-ID`); `SEQUENCE` bumps on every organiser-side send after the first.
  Scheduling mail is sent through the Mail Account's SMTP and appended to Sent, and is never a
  Composition. On synced Calendars the upstream sends, with a "Send invitations" toggle (default on)
  only where `canSuppressInviteMail` is true.
- An updated `REQUEST` for a held Invitation replaces the Event's fields and resets the Answer only
  when start or end changed; a `CANCEL` deletes the Series through the normal delete path, so the
  card reads "Cancelled by the organiser" and restore still works.
- Conflicts on the card count any busy, not-declined Occurrence on any of the User's Calendars
  (hidden ones included), computed in the Client inside the Event Window and fetched on demand
  outside it.
- The Notifier gains a second Calendar notification kind, **Answer received**, with a per-User toggle
  beside Reminders; the #158 map's "Reminders are the one Notifier addition" is amended.
- A User with a Local Calendar and no Mail Account sees the attendee field disabled with "Connect a
  mail account to invite people".
- Out of scope, recorded on the map: propose new time (`COUNTER`), a note to the organiser with an
  Answer, delegation, forwarding an Invitation from the card.
