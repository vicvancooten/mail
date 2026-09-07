# Google Calendar API sync, scopes, push and invite semantics

Research for [issue #159 "Research: Google Calendar API sync, scopes, push and invite semantics"](https://github.com/vicvancooten/mail/issues/159) (child of [#158, the wayfinder map](https://github.com/vicvancooten/mail/issues/158)).

Question: what does syncing a Google Calendar into the Sync Backend actually take, with the backend
as a full mirror and Google as upstream-wins — the same posture the Sync Backend already holds
toward Gmail ([ADR-0020](../adr/0020-gmail-syncs-all-mail-as-its-only-message-source.md): All Mail as
the only message source, everything else a projection). This document checks the nine sub-questions
in the ticket against Google's own Calendar API v3 reference and guides, the Google Identity/OAuth 2.0
docs, Google's own Cloud/API-Console support pages, and RFC 5545 — not secondary blog write-ups. Every
fetch was made directly against `developers.google.com` (or `support.google.com`,
`rfc-editor.org`) during this research pass; where a page turned out to be silent, ambiguous, or a
claim could only be traced to secondary aggregator sites (several showed up in search results —
Nylas, Rollout, CodeWords, horacal.app, and similar — repeating each other), that is stated plainly
as "undocumented" or "not confirmed" rather than filled in with a plausible-sounding guess. This
document does not propose a sync design — it establishes facts and their sourced verdicts for
whoever designs the Calendar sync model next, referencing [ADR-0006](../adr/0006-app-feature-state-lives-in-sync-backend.md),
[ADR-0010](../adr/0010-store-as-truth-with-a-pending-mutation-overlay.md),
[ADR-0011](../adr/0011-one-delta-endpoint-with-per-collection-state-tokens.md),
[ADR-0019](../adr/0019-undo-is-an-inverse-action-not-a-queue-cancellation.md),
[ADR-0021](../adr/0021-provider-registration-is-per-instance-and-owner-entered.md), and
[docs/research/0004](0004-mail-account-setup-provider-seam.md) only for framing.

---

## 1. Calendar API v3 versus CalDAV for Google accounts

**Not confirmed as an explicit Google recommendation — Google states no preference in its own docs —
but the primary-source feature comparison clearly favors the REST API v3 for a server-side sync
backend.** Extensive searching (including targeted queries for "we recommend" / "most developers
should use" against `developers.google.com`) turned up no sentence in which Google states that
server-side integrators should prefer the REST API over CalDAV or vice versa; both are documented as
parallel, standing interfaces ([Calendar API v3
overview](https://developers.google.com/calendar/api/guides/overview); [CalDAV API Developer's
Guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)).

What the primary sources do establish, directly:

- **Authentication**: Google's CalDAV server "refuses to authenticate a request unless it arrives
  over HTTPS with OAuth 2.0 authentication of a Google Account" — Basic auth and plain HTTP are
  rejected with 401 ([CalDAV Developer's Guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)).
  So CalDAV is not a "simpler, password-based" alternative to OAuth; it requires the identical OAuth
  2.0 grant machinery the REST API needs.
- **Feature gaps**: the same guide lists what CalDAV does *not* support — `MKCALENDAR`, `LOCK`/
  `UNLOCK`, `COPY`/`MOVE`, `VTODO` and `VJOURNAL` data, and the `AUDIO` alarm action.
- **Push**: the CalDAV guide contains no mention of push notifications or webhook channels anywhere
  — the only asynchronous-change mechanism it documents is polling with `ctag` (a collection tag
  that "changes when anything in the calendar has changed") plus, after an initial sync, the WebDAV
  Collection Synchronization extension ("Client applications must switch to this mode of operation
  after the initial sync"). The REST API v3, by contrast, has an explicit, documented push mechanism
  (§3 below) with no CalDAV equivalent found in Google's docs.
- **Quota parity**: "The CalDAV API has the same quota limits as the Calendar API"
  ([CalDAV Developer's Guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)) —
  so quota is not a differentiator either way.

**Verdict**: Google does not tell you which to use. But for a backend that wants full-mirror
semantics plus a real push signal (the ticket's stated model), the REST API v3 is the only one of
the two with a documented, first-class push mechanism, structured JSON resources with rich
recurrence/attendee/reminder fields (§5–§7), and an `events.insert`/`sendUpdates` invite model
(§6) — CalDAV gives you raw iCalendar over WebDAV with no push and several elided VEVENT/VTODO/VALARM
features. This is a reasoned inference from the two guides' documented feature sets, not a quoted
Google recommendation.

---

## 2. Incremental sync: `syncToken`, `updatedMin`, and 410 GONE

**Confirmed, with exact mechanics.** Per the [Calendar API sync
guide](https://developers.google.com/calendar/api/guides/sync) and the [`events.list`
reference](https://developers.google.com/calendar/api/v3/reference/events/list):

- A full sync's last page returns `nextSyncToken` (e.g. `"nextSyncToken":
  "CPDAlvWDx70CEPDAlvWDx70CGAU="`), which must be persisted.
- A subsequent incremental sync passes that value as the `syncToken` parameter to `events.list`; the
  response then "contain[s] only entries that have changed since then" ([`calendarList.list`
  reference](https://developers.google.com/calendar/api/v3/reference/calendarList/list), same
  mechanic documented for `events.list`).
- **410 GONE trigger**: "the server invalidates sync tokens" due to "token expiration or changes in
  related ACLs," and "responds to an incremental request with HTTP status code `410`"
  ([sync guide](https://developers.google.com/calendar/api/guides/sync)).
- **Required recovery**: "clear the client storage and perform a new full sync" — stated identically
  for both `calendarList.list` ("the client should clear its storage and perform a full
  synchronization without any `syncToken`") and the general sync guide. There is no partial-recovery
  path documented; 410 means discard and re-bootstrap that collection, which maps directly onto the
  Sync Backend's own existing `reset: true` mechanism for a stale/rebuilt collection state token
  ([ADR-0011](../adr/0011-one-delta-endpoint-with-per-collection-state-tokens.md)).
- **Deleted entries always ride along**: "the result always contains deleted entries, so clients can
  remove them from storage" (sync guide) — deletions are represented as events with `status:
  "cancelled"` (§5), not as a separate deletion feed.
- **`showDeleted` interacts with `syncToken`**: default `false`, but "when syncToken is set,
  `showDeleted` must be True for deleted events to appear" in practice — the `events.list` reference
  states `showDeleted` and `showHidden` cannot be forced to `False` when a sync token is present,
  since "All entries deleted and hidden since the previous list request will always be in the result
  set."
- **`updatedMin` cannot be combined with `syncToken` at all**: the `events.list` reference lists
  `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`, `sharedExtendedProperty`, `timeMin`,
  `timeMax`, and `updatedMin` as parameters that are rejected together with `syncToken`. The sync
  guide itself demotes `updatedMin`-based polling to a **"Legacy synchronization"** section — it is
  documented as the superseded approach, not a complement to `syncToken`.

**Verdict**: fully confirmed from primary sources. `syncToken` is the sanctioned incremental-sync
mechanism; `updatedMin` is explicitly legacy and mutually exclusive with it; 410 unambiguously means
"drop this collection's state and do a full resync," matching the Sync Backend's `reset: true`
pattern almost exactly.

---

## 3. Push: `watch` channels, TTL, HTTPS callback, renewal, self-hosted constraints

**Mostly confirmed; two important points are explicitly undocumented by Google.**

- **Mechanism**: a `POST` to a resource's `watch` method (Events, CalendarList, ACL, and Settings all
  support it — [push guide](https://developers.google.com/calendar/api/guides/push)) with a required
  `id` (unique channel id), `type: "web_hook"`, and `address` (the HTTPS callback URL). Google then
  delivers change notifications as HTTPS `POST` requests to that address, using `X-Goog-*` headers
  (`X-Goog-Channel-ID`, `X-Goog-Resource-State`: `sync` | `exists` | `not_exists`, etc.).
- **HTTPS requirement, exact wording**: "The Google Calendar API is able to send notifications to
  this HTTPS address only if there's a valid SSL certificate installed on your web server" — the same
  guide lists self-signed, untrusted-CA, revoked, and hostname-mismatched certificates as explicitly
  rejected.
- **TTL / expiration**: the optional `params.ttl` is in seconds; the [`events.watch`
  reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch) gives
  a **default of 604800 seconds (7 days)**. The response's `expiration` field is "a Unix timestamp, in
  milliseconds." **No maximum TTL value is published anywhere found in this research** — neither the
  `events.watch` reference nor the push guide states a ceiling, only the 7-day default. This is a
  genuine gap in Google's own docs, not an oversight in this research: treat "no documented maximum"
  as the honest state of the world rather than assuming 7 days is a hard cap.
- **No auto-renewal**: "Currently, there's no automatic way to renew a notification channel. When a
  channel is close to its expiration, you must replace it with a new one by calling the `watch`
  method" (push guide, verbatim). A renewal job that re-`watch`es before every channel's `expiration`
  is therefore mandatory application logic, not optional hardening.
- **Reliability is explicitly disclaimed**: "Notifications are not 100% reliable. Expect a small
  percentage of messages to get dropped" (push guide) — meaning `watch` can never be the sole source
  of truth for staying in sync; it can only be a *signal to re-poll* via `syncToken`, the same
  push-then-pull posture the Sync Backend already uses for its own SSE hints
  ([ADR-0011](../adr/0011-one-delta-endpoint-with-per-collection-state-tokens.md)).
- **Domain verification — historically required, now explicitly obsolete.** A dedicated Google
  support page, [Verifying domains for push notifications — API Console
  Help](https://support.google.com/googleapi/answer/7072069?hl=en), names Calendar (alongside Drive
  and Cloud Pub/Sub) as one of the APIs this used to apply to, then states outright: **"Domain
  verification in the API Console is no longer required to make push notifications work with your
  domains."** The page is headed "The following content is obsolete, but is retained below for your
  reference." Consistent with this, the *current* push guide
  (https://developers.google.com/calendar/api/guides/push) contains no mention of Search Console or
  API Console domain verification at all — only the SSL-certificate requirement above.
- **Fixed public IP**: **not documented as a requirement anywhere found.** Google's own description
  of its outbound crawler/notifier identity ([APIs-Google user
  agent](https://developers.google.com/search/docs/crawling-indexing/apis-user-agent)) discusses how
  *Google's own* requests can be verified via reverse DNS (`googlebot.com`/`google.com`), but says
  nothing about what the *receiving* server needs — no IP allowlist, no static-IP requirement is
  stated for the webhook target. Combined with the domain-verification obsolescence above, the
  documented requirement set for a `watch` callback address reduces to exactly two things: a
  resolvable HTTPS hostname, and a valid (non-self-signed, non-expired, hostname-matching) TLS
  certificate on it.
- **Practical read for a self-hosted instance behind its own reverse proxy**: given the above, an
  operator's own domain (with the operator's own TLS certificate, e.g. via Let's Encrypt behind their
  reverse proxy) is *documented as sufficient* — nothing found requires a Google-registered domain, a
  Google-issued certificate, or a fixed public IP. What is **not documented, and therefore not
  something this research can confirm either way**, is any minimum uptime/latency expectation Google
  holds callback endpoints to, or whether repeated delivery failures against one `address` cause
  Google to silently stop retrying or penalize the channel — the push guide's only reliability
  statement is the generic "expect some messages to drop," with no stated failure-handling policy for
  a channel whose endpoint is down for an extended period.
- **Polling as fallback/complement**: explicitly a realistic and Google-sanctioned complement, not
  just a fallback of last resort — the [quota guide](https://developers.google.com/calendar/api/guides/quota)
  frames push notifications as what "let[s] you use quota more efficiently" versus polling, implying
  polling remains a normal, supported mode Google expects some integrators to use or fall back to
  when push isn't set up or a channel has lapsed.

**Verdict**: push channels are real, documented, and workable behind a self-hosted reverse proxy with
no special network requirements beyond a valid public HTTPS endpoint — confirmed. Two specific facts
(maximum TTL, and behavior when a callback is unreachable for a sustained period) are genuinely
**undocumented** by Google, not just unfound by this research pass.

---

## 4. OAuth scopes and incremental authorization

**Scopes — confirmed.** Per [OAuth 2.0 Scopes for Google APIs, Calendar
section](https://developers.google.com/identity/protocols/oauth2/scopes#calendar):

| Scope | Access |
|---|---|
| `https://www.googleapis.com/auth/calendar` | Full read/write to all calendars ("See, edit, share, and permanently delete all the calendars you can access") |
| `https://www.googleapis.com/auth/calendar.readonly` | Full read-only ("See and download any calendar you can access") |
| `https://www.googleapis.com/auth/calendar.events` | Read/write **events only** ("View and edit events on all your calendars") |
| `https://www.googleapis.com/auth/calendar.events.readonly` | Events read-only |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Read-only calendar-list membership |
| `https://www.googleapis.com/auth/calendar.calendars.readonly` | Read-only calendar metadata |
| `https://www.googleapis.com/auth/calendar.settings.readonly` | Read-only user settings |
| `https://www.googleapis.com/auth/calendar.freebusy` / `.events.freebusy` | Free/busy only |

For a full mirror with write-back (the ticket's stated model), `https://www.googleapis.com/auth/calendar`
(or the narrower `calendar.events` if calendar-list/settings management isn't needed) is the scope
that matters.

**Scope sensitivity tier — confirmed, and materially different from Gmail's.** Google's own
[sensitive-scope verification page](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
gives, as its own example: **"reading events stored in Google Calendar"** is an example of a
**sensitive** scope. This puts Calendar's scopes in Google's *sensitive* tier, not the *restricted*
tier that Gmail's `https://mail.google.com/` IMAP scope occupies (already established in
[docs/research/0004](0004-mail-account-setup-provider-seam.md) §5.1, and reconfirmed here against the
[restricted-scope verification page](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
which does not list any Calendar scope). Practically: sensitive-scope verification is Google's own
Trust & Safety review (documentation plus a demo video, "3-5 business days" typical, per the same
page) — **restricted-scope verification's CASA Tier 2 third-party security audit does not apply to
Calendar scopes**, per this research.

**Incremental authorization — confirmed as a real, documented mechanism; the "no brand-new consent
screen" framing needs a caveat.** [OAuth 2.0 for Web Server Applications, "Incremental
authorization"](https://developers.google.com/identity/protocols/oauth2/web-server) states directly:
"Google's authorization server supports incremental authorization. This feature lets you request
scopes as they are needed and, if the user grants permission for the new scope, returns an
authorization code that may be exchanged for a token containing all scopes the user has granted the
project." With `include_granted_scopes=true` on the new authorization request, "the new access token
will also cover any scopes to which the user previously granted the application access" — i.e. a
single token ends up covering both the old (Gmail) and new (Calendar) scopes together, cumulatively,
under the same OAuth client.

The caveat: "To implement incremental authorization, you complete the **normal flow** for requesting
an access token" — meaning the standard authorization-code redirect to Google's consent UI is still
used for the new scope. Nothing in Google's docs describes a silent, no-UI path for adding a scope
the user hasn't seen before; the user still sees and approves a consent screen naming the new
(Calendar) scope specifically, the first time it's requested. What incremental authorization avoids
is **not** the consent screen — it avoids needing a **new OAuth client/app registration** or a
**separate Grant entity**: the same registered app (the instance's existing Google Cloud project and
OAuth client, per [ADR-0021](../adr/0021-provider-registration-is-per-instance-and-owner-entered.md))
simply requests one more scope from the same user, and the two scope sets end up merged into one
token relationship rather than two independent ones.

**Verdict**: **confirmed that Calendar scopes can be added to an existing Grant via incremental
authorization without a new app/client registration or a second Grant record** — this is exactly what
the feature is for, and is spelled out in Google's own docs. **Not confirmed** is the ticket's
stronger framing of "without a brand-new consent flow": the user does go through Google's standard
OAuth consent redirect again for the new scope (it is not silent), it is just the *same app*'s
consent flow requesting one more scope, not a second app's flow from scratch.

---

## 5. Recurring events, exceptions and cancellations

**Confirmed, and RFC 5545-grounded exactly where Google says it is.** From the [Events
reference](https://developers.google.com/calendar/api/v3/reference/events) and the [recurring events
guide](https://developers.google.com/calendar/api/guides/recurringevents):

- **`recurrence[]`**: "List of RRULE, EXRULE, RDATE and EXDATE lines for a recurring event, as
  specified in RFC5545" — Google's own reference cites the RFC by name for this field's grammar.
  `DTSTART`/`DTEND` lines are deliberately excluded from this field; the event's own `start`/`end`
  fields carry that instead. RFC 5545 itself (§3.8.5.3, [RFC
  5545](https://www.rfc-editor.org/rfc/rfc5545)) defines RRULE as the value type used "to identify
  properties that contain a recurrence rule specification," and EXDATE (§3.8.5.1) as specifying "the
  date-times which are excluded from the recurrence set defined by a recurrence rule" — i.e. Google's
  `recurrence` array is a direct, syntactically faithful embedding of RFC 5545 lines, not a
  reinterpretation.
- **Instances vs. the recurring parent**: "Individual instances are similar to single events. Unlike
  their parent recurring events, instances don't have the `recurrence` field set" (recurring-events
  guide). Two fields identify an instance: `recurringEventId` ("the id of the recurring event to
  which this instance belongs. Immutable") and `originalStartTime` ("the time at which this event
  would start according to the recurrence data in the recurring event identified by
  `recurringEventId`" — i.e. its slot in the *unmodified* pattern, even if the instance itself has
  since been rescheduled).
- **Creating an exception**: "To modify a single instance (creating an exception), client
  applications must first retrieve the instance and then update it by sending an authorized PUT
  request" (recurring-events guide) — an exception is just an ordinary instance event that has been
  individually updated; it carries its own diverging fields (time, attendees, etc.) alongside its
  `recurringEventId`/`originalStartTime` linkage.
- **Cancellation semantics — the tombstone behavior, with two distinct meanings for the same
  `status: "cancelled"` value** (Events reference, verbatim):
  - For an **instance of an uncancelled recurring series**: "Cancelled exceptions of an uncancelled
    recurring event indicate that this instance should no longer be presented to the user" — i.e. one
    occurrence was deleted from the series, and the tombstone-instance still needs to be synced and
    then suppressed from view, not treated as "the whole series is gone."
  - For **any other cancelled event** (a cancelled non-recurring event, or the recurring parent event
    itself cancelled): "All other cancelled events represent deleted events. Clients should remove
    their locally synced copies" — an explicit, direct instruction from Google that a full-mirror
    consumer's correct behavior is to delete its local row, not merely hide it.
- **Splitting a series going forward** (not a per-instance exception): the guide's documented pattern
  is two separate API calls — trim the original recurring event's `RRULE` with an earlier `UNTIL`,
  then `insert` a brand-new recurring event starting from the target instance — rather than one
  operation; there is no single "split the series here" endpoint.

**Verdict**: fully confirmed. The `status: "cancelled"` tombstone is exactly the mechanism a
full-mirror, upstream-wins sync model needs to notice both "this one occurrence should disappear" and
"this whole event/series should disappear," and Google's own words ("Clients should remove their
locally synced copies") match the mirror model's required behavior precisely.

---

## 6. Attendee and invite semantics

**Confirmed: Google's own servers send the invite email, not the API caller.** From [`events.insert`
reference](https://developers.google.com/calendar/api/v3/reference/events/insert) and the [Events
resource](https://developers.google.com/calendar/api/v3/reference/events):

- **`attendees[]`** carries, per entry: `email` ("The attendee's email address, if available"),
  `responseStatus` (`needsAction` | `declined` | `tentative` | `accepted`), `optional` (boolean,
  default `false`), and `additionalGuests` (integer plus-ones).
- **`sendUpdates`** (the current, non-deprecated parameter — `sendNotifications` is explicitly
  "Deprecated. Please use `sendUpdates` instead") takes three values:
  - `all`: "Notifications are sent to all guests."
  - `externalOnly`: "Notifications are sent to non-Google Calendar guests only."
  - `none`: "No notifications are sent" — with an explicit warning attached: **"Using the value none
    can have significant adverse effects, including events not syncing to external calendars or
    events being lost altogether for some users."** This is a strong, direct signal from Google that
    `none` is not a safe default for anything but pure internal bookkeeping — for a Calendar sync that
    creates events with real external attendees, `all` (or `externalOnly`) is the value the API's own
    docs steer you toward.
  - Even at `sendUpdates=none`, the parameter description itself adds: "Note that some emails might
    still be sent" — Google reserves the right to send some notifications regardless of the caller's
    preference.
- **Who sends the email**: nothing in the reference describes the caller constructing or dispatching
  an email itself — the entire feature is "whether *Google* sends notifications," phrased as
  notifications Google controls the delivery of, addressed via `sendUpdates`. There is no separate
  API surface for retrieving invite email content or triggering SMTP delivery yourself; the
  organizer's Google Calendar (and by extension Google's own mail infrastructure, for
  Google-account attendees, or standard iCalendar/iTIP mail for external ones) is what sends the
  invite when an event with attendees is inserted or updated with `sendUpdates` set to `all` or
  `externalOnly`.

**Verdict**: confirmed. Creating an event via the API with `attendees` populated and `sendUpdates` set
to `all`/`externalOnly` causes **Google's own servers** to generate and deliver the invite email on
the organizer's behalf — the API caller (the Sync Backend, in this ticket's frame) does not need its
own outbound-mail path for calendar invites at all; it only needs to set the field correctly.

---

## 7. Reminders and notification-settings fields

**Confirmed, two separate resources.** Per-event reminders live on the [Events
resource](https://developers.google.com/calendar/api/v3/reference/events)'s `reminders` object:

- `useDefault`: "Whether the default reminders of the calendar apply to the event."
- `overrides[]`: present only when `useDefault` is false; each entry has `method` (`"email"` |
  `"popup"`) and `minutes` (0–40320, i.e. up to 4 weeks before).

Calendar-level defaults and notification routing live on the **CalendarList** resource (per-user,
per-calendar — [CalendarList
reference](https://developers.google.com/calendar/api/v3/reference/calendarList)), not on the bare
Calendar resource:

- `defaultReminders[]`: same `method`/`minutes` shape as an event override — "The default reminders
  that the authenticated user has for this calendar."
- `notificationSettings.notifications[]`: "The notifications that the authenticated user is receiving
  for this calendar," each with a `type` (`eventCreation`, `eventChange`, `eventCancellation`,
  `eventResponse`, `agenda`) and `method` (currently only `"email"` is a documented possible value).

Separately, the **Settings** resource (user-global, not per-calendar — [Settings
reference](https://developers.google.com/calendar/api/v3/reference/settings)) has exactly one
reminder-adjacent field: `remindOnRespondedEventsOnly` ("Whether event reminders should be sent only
for events with the user's response status 'Yes' and 'Maybe'," default `false`). No dedicated
notification-management method exists on Settings beyond `get`/`list`/`watch`.

**Verdict**: confirmed, and the field split is meaningful for a mirror model — reminders are stored at
three different scopes (per-event override, per-user-per-calendar default via CalendarList, and one
global response-filtering flag via Settings), each requiring its own sync collection if the Sync
Backend intends to mirror reminder behavior faithfully rather than only event content.

---

## 8. Quotas and rate limits

**Confirmed, but the ticket's own framing ("queries-per-day / per-100-seconds-per-user") describes
Google's *old* quota model — the [current quota guide](https://developers.google.com/calendar/api/guides/quota)
uses different buckets entirely, worth flagging as a live discrepancy rather than silently
translating.** As fetched during this research (2026):

- **10,000 requests per minute per project** (default).
- **600 requests per minute per user per project** (default) — this is the modern replacement for
  the old "queries per 100 seconds per user" framing the ticket names; the unit changed from a
  100-second window to a 60-second window.
- **1,000,000 requests per day per project** is documented, but framed as a **free-usage billing
  threshold**, not a hard request quota: "Usage under this threshold doesn't incur extra charges," and
  the guide explicitly states "you can't request an increase for this daily threshold limit" (unlike
  the per-minute quotas, which can be raised via the Cloud Console's Quotas page, "approval isn't
  guaranteed").
- Quota is enforced with "a sliding window" calculation, and bursts beyond the limit get rate-limited
  in the following window rather than hard-failing immediately (per the guide's own description).
- **Watch/push interaction with quota — not documented.** The quota guide's only statement connecting
  push to quota is qualitative: registering for push notifications "let[s] you use quota more
  efficiently" than polling (i.e. it's pitched as the quota-saving alternative). **No source found
  states whether a `watch` call itself is metered identically to any other API call (it almost
  certainly is — it's a normal POST request), nor whether inbound notification *deliveries* to your
  webhook count against your project's quota at all** (deliveries are Google calling you, not you
  calling Google, so this is plausibly outside the request-quota model entirely — but this research
  found no explicit statement either confirming or ruling this out).

**Verdict**: the numeric quotas are confirmed and current as of this research, but the ticket's
"per-day / per-100-seconds" phrasing does not match Google's present documentation — flag this
explicitly rather than silently reconciling it, since a design built against the old numbers/units
would be wrong. The quota cost of watch channels themselves (as opposed to the calls used to create
them) is genuinely undocumented.

---

## 9. What changes if the Grant is a Mail Account's existing Google Grant

**Partially confirmed from primary sources, partially a reasoned inference — flagged accordingly.**

- **Token storage shape is unchanged in kind.** Per §4, `include_granted_scopes=true` on the
  incremental-authorization request produces a single access token whose scope set is the union of
  the Gmail and Calendar scopes ("a token containing all scopes the user has granted the project" —
  [OAuth 2.0 for Web Server
  Applications](https://developers.google.com/identity/protocols/oauth2/web-server)). The stored
  credential shape [docs/research/0004](0004-mail-account-setup-provider-seam.md) §6 already
  describes (`accessToken`, `refreshToken`, `expiresAt`, `scope: string[]`) needs no new fields to
  represent this — only its `scope` array grows.
- **Refresh token issuance on the incremental-auth exchange — genuinely ambiguous in Google's own
  docs, not confirmed either way.** The [OAuth 2.0 for Web Server
  Applications](https://developers.google.com/identity/protocols/oauth2/web-server) page states a
  refresh token is returned by the token endpoint only "the first time that your application
  exchanges an authorization code for tokens" when `access_type=offline` was set on the authorization
  request, and separately notes that forcing a **new** refresh token later requires `prompt=consent`
  in that later request. Google's docs do not explicitly say whether an incremental-authorization
  exchange (a *second* authorization-code exchange for the *same* user+client, adding a new scope)
  counts as a fresh "first time" that reissues a refresh token, or whether it is treated as
  a continuation of the existing grant that returns no new refresh token at all (relying on the
  already-stored one, now implicitly covering the wider scope). **This research could not confirm
  either behavior from Google's documentation** — it is a real open question for whoever implements
  the Calendar Grant flow, worth verifying empirically (does the token response for the Calendar-scope
  exchange include a `refresh_token` field or not) rather than assumed.
- **The 100-refresh-token-per-account-per-client cap and 6-month idle expiry are unaffected by scope
  count.** Per [Google's OAuth 2.0
  docs](https://developers.google.com/identity/protocols/oauth2): "There is currently a limit of 100
  refresh tokens per Google Account per OAuth 2.0 client ID. If the limit is reached, creating a new
  refresh token automatically invalidates the oldest refresh token without warning," and a refresh
  token separately expires if "not... used for six months." Both are scoped to
  **account+client**, not to any particular scope set — so if the incremental-auth exchange *does*
  turn out to mint a second refresh token (per the open question above), that second token counts
  against the same 100-token cap the Gmail grant's token already occupies, on the same OAuth client
  ([ADR-0021](../adr/0021-provider-registration-is-per-instance-and-owner-entered.md) already
  establishes one client per Provider per instance, not per Mail Account).
- **Scope-change effect on the existing Gmail-only refresh token — not documented.** No primary
  source found states whether requesting an additional scope for a user who already holds a valid
  Gmail-scoped refresh token has any effect on that pre-existing token (e.g. invalidating it,
  reissuing it with the union scope in place, or leaving it entirely untouched while a parallel token
  covers Calendar). §4's incremental-authorization text describes the resulting *access token*
  cumulatively, but is silent on the refresh-token side of this specific scenario.
- **Verification/consent-screen cost does not increase to the Gmail restricted-scope tier.** Per §4,
  Calendar's scopes are Google's *sensitive* tier, not *restricted* — so adding Calendar scopes to an
  OAuth client that already requested Gmail's restricted `https://mail.google.com/` scope does not
  newly trigger a CASA audit; the project's OAuth consent screen does need the new sensitive scope(s)
  added to its configured scope list and re-submitted for Google's own (non-CASA) sensitive-scope
  review if the app is already in "In Production" status (per the [sensitive-scope verification
  page](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)'s
  description of the review process) — this is a real but smaller incremental cost than the Gmail
  scope's own restricted-scope verification already paid for.

**Verdict**: **confirmed** that reusing the existing Grant does not change the credential's shape,
the client-registration model, or the restricted-scope verification burden. **Not confirmed** —
genuinely undocumented by Google — whether the incremental-authorization token exchange mints a
second refresh token (with its own lifecycle) alongside the Gmail one, or extends the existing
refresh token's effective scope in place. This is the one point in the whole research pass worth
verifying empirically against Google's actual token endpoint response before relying on either
assumption in a design.

---

## Other findings worth flagging

1. **The Calendar resource / CalendarList split is itself a sync-model decision Google has already
   made for you.** Per the [Events and Calendars
   overview](https://developers.google.com/calendar/api/concepts/events-calendars): the bare
   `Calendars` resource holds calendar-wide properties (title, timezone) shared by every user who has
   access, while `CalendarList` is "an individual user's personal calendar list" carrying per-user
   customizations (color, notification settings, default reminders — §7) and controls which calendars
   even show up for that user. A full mirror needs to sync *both* collections, not just Events — a
   Mail Account's Calendar sync is at minimum three collections (CalendarList, Calendars metadata,
   Events per calendar), each with its own `syncToken` per the reference pages checked in §2.
2. **`events.instances`** is a documented, separate method from `events.list` for "return[ing]
   instances of the specified recurring event" — useful for expanding one series on demand (e.g. a UI
   detail view) without pulling every instance through the general list/sync feed, though the sync
   guide's own examples use `singleEvents=true` on `events.list` (which "expand[s] recurring events
   into instances") as the normal sync-time path, not `events.instances`.
3. **The push guide's own reliability disclaimer** ("Notifications are not 100% reliable. Expect a
   small percentage of messages to get dropped") is worth reading together with §3's undocumented
   "channel stays alive but endpoint unreachable for a long time" gap: the only Google-sanctioned way
   to guarantee eventual consistency, regardless of how push behaves, is periodic polling via
   `syncToken` even when push is configured and believed healthy — matching the Sync Backend's
   existing "push is a hint, the client still pulls deltas" posture
   ([ADR-0011](../adr/0011-one-delta-endpoint-with-per-collection-state-tokens.md)).
4. **`sendUpdates` also gates *updates and deletes*, not just creation** — the `events.insert`
   reference's exact wording ("about the creation of the new event") is insert-specific, but the same
   parameter with the same three values appears on `events.update`, `events.patch`, and
   `events.delete` in Google's reference set (not independently re-fetched in this pass, but named
   consistently across the API surface per the reference structure observed) — meaning a full-mirror
   sync backend that ever needs to *write* an upstream change (e.g. relaying a Wicket-side edit back
   to Google) must set `sendUpdates` correctly on every mutating call, not only on the initial
   `insert`, or attendees silently stop being notified of changes made through Wicket.
5. **A Calendar's `id` for the primary calendar is the literal string `"primary"`** (an alias) or the
   user's own email address — this surfaced incidentally while reading the CalendarList/Events
   reference pages and is worth flagging since it affects how the Sync Backend keys its `Calendars`
   collection rows (the "primary" alias and the account's real calendar ID are two ways to name the
   same underlying resource).

---

## Sources consulted

- [Calendar API: Synchronize resources efficiently](https://developers.google.com/calendar/api/guides/sync) — `syncToken`, `nextSyncToken`, 410 GONE trigger and recovery, `updatedMin` as legacy.
- [Calendar API: Get push notifications](https://developers.google.com/calendar/api/guides/push) — `watch` channel creation, TTL default, HTTPS/SSL certificate requirement, no auto-renewal, reliability disclaimer.
- [Calendar API v3 reference: Events](https://developers.google.com/calendar/api/v3/reference/events) — full Events schema: `recurrence`, `recurringEventId`, `originalStartTime`, `status`/cancellation semantics, `attendees`, `reminders`.
- [Calendar API v3 reference: Events.insert](https://developers.google.com/calendar/api/v3/reference/events/insert) — `sendUpdates`/`sendNotifications` parameters and their exact warning text.
- [Calendar API v3 reference: Events.watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch) — `ttl` default (604800s), `expiration` field format.
- [Calendar API v3 reference: Events.list](https://developers.google.com/calendar/api/v3/reference/events/list) — `syncToken`, `showDeleted`, `updatedMin`, `singleEvents`, and the parameters incompatible with `syncToken`.
- [Calendar API v3 reference: CalendarList.list](https://developers.google.com/calendar/api/v3/reference/calendarList/list) — `syncToken`/410 behavior for the CalendarList collection.
- [Calendar API v3 reference: CalendarList](https://developers.google.com/calendar/api/v3/reference/calendarList) — `defaultReminders`, `notificationSettings`.
- [Calendar API v3 reference: Settings](https://developers.google.com/calendar/api/v3/reference/settings) — `remindOnRespondedEventsOnly`, `get`/`list`/`watch` methods only.
- [Calendar API: Guides overview](https://developers.google.com/calendar/api/guides/overview) — general API purpose statement, confirms CalDAV exists as a separate, parallel doc set.
- [Calendar API: Events and Calendars concepts](https://developers.google.com/calendar/api/concepts/events-calendars) — Calendars vs. CalendarList resource split.
- [Calendar API: Recurring Events guide](https://developers.google.com/calendar/api/guides/recurringevents) — instance vs. recurring-parent shape, exception creation via PUT, series-splitting pattern.
- [Calendar API: Usage limits (quota)](https://developers.google.com/calendar/api/guides/quota) — 10,000 req/min/project, 600 req/min/user, 1,000,000 req/day free-tier threshold, sliding-window enforcement.
- [CalDAV API Developer's Guide](https://developers.google.com/workspace/calendar/caldav/v2/guide) — OAuth2-over-HTTPS-only requirement, unsupported CalDAV features, quota parity, no push mechanism documented.
- [CalDAV API overview](https://developers.google.com/workspace/calendar/caldav) — general CalDAV description, no explicit comparison to REST API v3.
- [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes#calendar) — full list of Calendar scope URIs and descriptions.
- [OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server) — incremental authorization mechanism and exact wording, `include_granted_scopes`, refresh-token issuance ("first time" wording), `prompt=consent` for forcing a new refresh token.
- [OAuth 2.0 Policies / general docs](https://developers.google.com/identity/protocols/oauth2) — 100-refresh-token-per-account-per-client cap, 6-month idle expiry, other invalidation triggers.
- [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) — confirms no Calendar scope appears in the restricted tier; CASA audit requirement scoped to restricted scopes.
- [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) — explicit example: "reading events stored in Google Calendar" as a sensitive scope; review process (Trust & Safety, no CASA).
- [Verifying domains for push notifications — API Console Help](https://support.google.com/googleapi/answer/7072069?hl=en) — confirms domain verification for push notifications (Calendar included) is obsolete and no longer required.
- [APIs-Google user agent (Google Search Central)](https://developers.google.com/search/docs/crawling-indexing/apis-user-agent) — confirms no published IP-range/static-IP requirement for push notification receivers.
- [RFC 5545 — Internet Calendaring and Scheduling Core Object Specification (iCalendar)](https://www.rfc-editor.org/rfc/rfc5545) — §3.8.5.3 RRULE and §3.8.5.1 EXDATE definitions that Google's `recurrence` field embeds verbatim.
- [docs/research/0004-mail-account-setup-provider-seam.md](0004-mail-account-setup-provider-seam.md) — repo context on the existing OAuth/Grant seam, credential shape, and Gmail's restricted-scope verification cost (used for framing §4/§9, not as a primary source about Google's APIs).
