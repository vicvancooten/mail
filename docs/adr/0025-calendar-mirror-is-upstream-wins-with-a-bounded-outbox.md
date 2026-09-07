# The Calendar mirror is upstream-wins, with a bounded outbox and late Rollbacks

Calendar sync ([#158](https://github.com/vicvancooten/mail/issues/158)) brings the first synced
collection whose upstream can *refuse* a write: Google, Microsoft Graph and CalDAV all reject a stale
or malformed Event where IMAP quietly accepts a flag. We decided that the Sync Backend holds a **whole
mirror** of each synced Calendar as Series and Overrides in RFC 5545 form, **materialises**
Occurrences for a bounded window and ships only those to the Client, applies edits **store-first**
through an **outbox with a deadline**, and on any upstream refusal or concurrent upstream change lets
the **upstream win**: the mirror row reverts and the User sees a **late Rollback** on every open
device. Decided in the #168 grilling, 2026-09-07.

## Considered Options

- **Pushing upstream synchronously inside the mutation flush**, so a rejection rides the flush
  response like a store-side rejection does today: rejected. The flush would block on Google latency,
  fail outright when the upstream is down, and could not hold the queue on Needs Reauth as
  [ADR-0010](0010-store-as-truth-with-a-pending-mutation-overlay.md) requires.
- **Mail's outbox as it is** (retry forever, no attempt counter, reconcile silently on the next
  delta): rejected. For a flag it is harmless; for an Event it leaves a meeting on screen that the
  organiser's server never accepted, with nobody told.
- **Field-level merge on conflict**: rejected. Two writers on one Event is rare on a personal
  calendar, and a wrong merge is worse than a visible loss the User can redo.
- **A canonical structured recurrence object** (Graph's shape) with Google and CalDAV serialising:
  rejected. Two of three backends speak RFC 5545 natively, the expansion library consumes it directly
  and iMIP needs it verbatim; Graph's grammar is a strict subset, so Graph translates exactly and the
  editor offers only the subset every backend can express.
- **Shipping Series with rules to the Client and expanding there**: rejected per
  [docs/research/0163-icalendar-recurrence-tooling.md](../research/0163-icalendar-recurrence-tooling.md);
  the Client never bundles a recurrence engine and never disagrees with the Sync Backend about an
  expansion.
- **A bounded mirror** (only the Materialisation Window pulled from upstream): rejected for Google and
  CalDAV, whose incremental sync is calendar-wide anyway; adopted for Graph alone, whose delta is
  date-range-scoped, behind a per-Origin capability flag.
- **`reset: true` on the Event collection when a sync token dies**: rejected. Token loss is a
  Sync Backend concern, handled by re-listing and upserting into the existing mirror rows so the
  Client sees ordinary deltas and keeps its window and pending overlay.

## Consequences

- **Series, Occurrence, Override** are the storage vocabulary (`CONTEXT.md`). Recurrence is
  `rrules`/`rdates`/`exdates` strings; a cancelled Occurrence is an `exdate` and nothing more, because
  Graph can only ever name a cancelled instance by id. "This and following" is a split: `UNTIL` on the
  old Series and a new Series with a new `UID`, one intent executed as two upstream writes.
- **Two windows.** The Materialisation Window (about one year back, two forward) is where Occurrences
  exist as rows; the Event Window (about three months back, twelve forward) is what the Client syncs.
  Both roll daily on the Sync Backend; outside the Event Window the Client fetches a range on demand
  and shows it without the pending overlay. Both edges travel in the sync response so the Client can
  draw them honestly, as the Index Watermark does for mail.
- **Occurrence rows are list projections** (`<seriesId>@<originalStart>`, times, title, location,
  status, transparency, flags); the Series body (description, attendees, rules, attachments,
  conferencing) is an on-demand fetch like a mail body. Edit intents name the Series, the scope
  (`this`, `thisAndFollowing`, `all`) and the original start.
- **Times**: timed Events are `{ instant, tzid }`, all-day Events are exclusive-end date pairs with no
  zone ever attached, floating Events ship as wall clock plus a flag and resolve in the viewer's zone.
- **Identity**: a Client-generated ULID is the Series id; `UID` is `<seriesId>@<instance host>` for
  everything created in Wicket; the upstream id, etag and `SEQUENCE` sit beside it, and `SEQUENCE` is
  incremented by Wicket only on Local Calendars, where the Sync Backend is the organiser's authority.
- **Outbox rows carry `attempts`, `nextAttemptAt`, `deadline`, `lastError`.** A permanent 4xx rejects
  at once; transient failures retry with backoff to a 24-hour deadline, then reject; Needs Reauth holds
  with no deadline. Local Calendars have no outbox: a write is final on flush.
- **Conflict is any of three things**, all resolved the same way: an upstream rejection, a failed
  conditional write (`If-Match` on the mirrored etag, `changeKey` compared beforehand on Graph), or a
  delta touching a Series with a queued write. The Series is refetched, the mirror reverts, the queued
  write is dropped. Each mirrored Series keeps an `upstreamSnapshot` so the revert needs no network.
- **Rollback becomes a User-scoped collection** on `POST /sync`
  ([ADR-0011](0011-one-delta-endpoint-with-per-collection-state-tokens.md)): one row per rejected
  outbox entry, tombstoned after seven days, shown once per device as the existing rollback toast
  with Retry. This is the piece ADR-0011 described and mail never needed; mail may adopt it later,
  outside the Hub Apps effort.
- **Undo stays a real inverse** ([ADR-0019](0019-undo-is-an-inverse-action-not-a-queue-cancellation.md)):
  `restoreEvent` recreates a deleted Series from a snapshot kept 24 hours (status flip on Google, same
  `UID` on CalDAV, a fresh create remapped to the same Series id on Graph, which re-sends invites).
- **Capabilities per Calendar**, computed by the adapter and read by the Client to hide what would
  fail rather than roll it back: `writable`, `historyBounded`, `invitesSentByUpstream`,
  `canSuppressInviteMail`, `recurrenceGrammar`, `perEventReminders`, `attachments`, `conferencing`.
- **Sync cadence**: per-Calendar delta every 5 minutes while a Client of the User was active in the
  last day, every 30 minutes otherwise; CalDAV checks `getctag` first; the Calendar list re-lists every
  15 minutes and a vanished Calendar is tombstoned only after a second confirmation. Google `watch` and
  Graph subscriptions only schedule an immediate poll. Reminders (#170) must assume the 5-minute case.
- **Amends ADR-0011**: `Calendar`, `Event` (Occurrence rows) and `Rollback` join the collection list;
  `Event` is the one windowed App collection ADR-0023 anticipated.
