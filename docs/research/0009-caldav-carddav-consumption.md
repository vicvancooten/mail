# Consuming generic CalDAV and CardDAV servers

Research for [issue #161 "Research: consuming generic CalDAV and CardDAV
servers"](https://github.com/vicvancooten/mail/issues/161) (child of [#158, the Hub Apps wayfinder
map](https://github.com/vicvancooten/mail/issues/158)).

Question: what does consuming a generic CalDAV and CardDAV server take from the Sync Backend, for
Users on Other IMAP providers (Fastmail, iCloud, Nextcloud, a self-hosted WebDAV host)? This
document works through discovery, change detection, authentication, write semantics, scheduling and
CardDAV against the RFCs themselves and each vendor's own documentation, surveys the known
per-provider quirks with specifics rather than folklore, and ends with a sourced verdict on `tsdav`
as the TypeScript client library to build on (or not).

---

## 1. Discovery: from an email address to a calendar/addressbook-home-set

Three RFCs chain together to turn "an email address and a password" into a list of calendars or
address books, and none of them alone gets you there.

### 1.1 RFC 6764 — the `.well-known` bootstrap

**Primary source**: [RFC 6764, "Locating Services for Calendaring Extensions to WebDAV (CalDAV) and
vCard Extensions to WebDAV (CardDAV)"](https://www.rfc-editor.org/rfc/rfc6764).

§5 registers two well-known URIs, `caldav` and `carddav`: "the server MUST redirect HTTP requests
for that resource to the actual 'context path' using one of the available mechanisms provided by
HTTP." §5.1 walks the concrete case: a client resolves an FQDN (by DNS SRV or by taking the domain
literally), then requests `/.well-known/caldav`, which the server redirects (HTTP 301/302/307) to
wherever it actually serves CalDAV, e.g. `/servlet/caldav`.

§6 gives the full client procedure, in order:

1. **DNS SRV lookup** — `_caldavs._tcp.<domain>` (or `_carddavs._tcp.<domain>`) against the domain
   extracted from the user's identifier.
2. **Context path** — if no SRV/TXT record supplies one, "the initial 'context path' is taken to be
   `/.well-known/caldav`" (or `/.well-known/carddav`).
3. **`PROPFIND`** against that path, "with the request URI set to the initial 'context path'…
   clients MUST properly handle HTTP redirect responses for the request."
4. The `PROPFIND` body "SHOULD include the `DAV:current-user-principal` property as one of the
   properties to return" — folding step 2 of the RFC 5397 dance (below) into the same request.

In practice almost none of the four surveyed providers require the DNS SRV step — each publishes a
fixed hostname instead (§3, per-provider) — but the `.well-known` redirect + `current-user-principal`
`PROPFIND` combination is the one piece every provider examined actually implements.

### 1.2 RFC 5397 — `current-user-principal`

**Primary source**: [RFC 5397, "WebDAV Current Principal Extension"](https://www.rfc-editor.org/rfc/rfc5397).

§1 states the property's whole purpose: "This allows a client to 'bootstrap' itself by performing
additional queries on the principal resource to obtain additional information from that resource."
§3 defines the shape returned:

```xml
<D:current-user-principal xmlns:D="DAV:">
  <D:href>/principals/users/cdaboo</D:href>
</D:current-user-principal>
```

RFC 5397 itself is deliberately narrow — it defines only this one property, not the discovery
sequence around it (that's RFC 6764's job, and it says so explicitly by pointing elsewhere for the
wider bootstrap).

### 1.3 RFC 4791 / RFC 6352 — the home-set properties

**Primary sources**: [RFC 4791 §6.2.1](https://www.rfc-editor.org/rfc/rfc4791) (CalDAV) and
[RFC 6352 §7.1.1](https://www.rfc-editor.org/rfc/rfc6352) (CardDAV).

Once the client has the principal URL, a second `PROPFIND` against *that* resource asks for
`CALDAV:calendar-home-set` (namespace `urn:ietf:params:xml:ns:caldav`) or
`CARDDAV:addressbook-home-set` (namespace `urn:ietf:params:xml:ns:carddav`). RFC 4791 §6.2.1 defines
the element as `<!ELEMENT calendar-home-set (DAV:href*)>` and describes it as identifying "the URL of
any WebDAV collections that contain calendar collections owned by the associated principal
resource." RFC 6352 §7.1.1 is worded almost identically for address books. §8.4 of RFC 4791
("Finding Calendars") is explicit that this property exists specifically so clients don't have to
guess collection layout: it "allow[s] users to easily find the calendar collections owned by the
principal." Neither RFC specifies how many calendars/address books may live under a home-set, or
their layout — that's left entirely to the server, which is exactly where the per-provider quirks in
§7 below come from.

### 1.4 The full chain, and why every step matters in practice

Chained together, a client's first contact with an unknown server is:

`.well-known/caldav` (redirect) → `PROPFIND current-user-principal` (RFC 6764 folds this into the
same request; RFC 5397 defines the property) → `PROPFIND calendar-home-set` on the principal URL
(RFC 4791/6352) → `PROPFIND Depth:1` on the home-set to enumerate actual calendars/address books,
reading `resourcetype`, `displayname`, `getctag` and (CalDAV only) `supported-calendar-component-set`
along the way. [sabre/dav's own "Building a CalDAV client" guide](https://sabre.io/dav/building-a-caldav-client/)
— written by the maintainers of one of the most widely deployed server implementations — describes
exactly this sequence and calls out that a client should be able to start from nothing but a bare
server domain and a `PROPFIND` to `/`. Every step is independently skippable if the provider's exact
URL is already known (which is why every provider below publishes a fixed hostname), but a Sync
Backend that wants to support "a self-hosted WebDAV host" generically has to walk the whole chain,
because that's the one case where nothing is known in advance.

---

## 2. Efficient change detection

### 2.1 RFC 6578 — the `sync-collection` REPORT

**Primary source**: [RFC 6578, "Collection Synchronization for WebDAV"](https://www.rfc-editor.org/rfc/rfc6578).

§3.2 defines the request: a `DAV:sync-collection` body "MUST contain one `DAV:sync-token` XML
element, one `DAV:sync-level` element, and one `DAV:prop` XML element, and MAY contain a `DAV:limit`
element." An empty `sync-token` means "give me everything" (initial sync); a non-empty one means
"everything since this token." The response (§3.2) is a `DAV:multistatus` containing one
`DAV:response` per member URL that was added, changed or deleted, plus exactly one new
`DAV:sync-token` to store for next time. §3.3 governs scope via `sync-level`: `1` reports only
immediate children, `infinite` reports the whole subtree recursively. §3.6 covers truncation: if the
server can't return the whole change set at once, "the response MUST use status code 207
(Multi-Status)…and indicate a status of 507 (Insufficient Storage) for the request-URI" — meaning
the client must re-issue the request (with the partial `sync-token` it was given) to keep paging.

This REPORT is defined at the plain WebDAV (`DAV:`) level, not inside the CalDAV or CardDAV
namespace — it's a generic collection-sync mechanism that both CalDAV calendars and CardDAV address
books use identically (see §6 below).

### 2.2 What happens when a sync-token goes stale

RFC 6578 §3.2's own precondition text is unusually blunt about servers being allowed to just forget:
"Servers might need to invalidate tokens previously returned to clients. Doing so will cause the
clients to fall back to doing full synchronization." Critically, **the RFC itself does not mandate a
specific HTTP status code** for an invalid/expired token — it describes the consequence (full
resync) without pinning down the wire signal. In practice, [sabre/dav's client guide](https://sabre.io/dav/building-a-caldav-client/)
states plainly that SabreDAV-based servers return **403** when handed an unrecognized token, which a
client must be ready to interpret as "drop the token, start over" rather than a hard failure. A Sync
Backend consuming a truly generic server therefore cannot rely on a single status code to detect
token invalidation — it has to treat any REPORT failure against a stored sync-token as a signal to
fall back to a full resync, since the RFC leaves the exact server behavior unspecified.

### 2.3 The pre-RFC-6578 fallback: `ctag`/`getctag`

**Primary source**: [Apple's own `caldav-ctag.txt` draft](https://github.com/apple/ccs-calendarserver/blob/master/doc/Extensions/caldav-ctag.txt)
(authored by Cyrus Daboo, Apple Inc., predates RFC 6578). Its abstract: "This specification defines
an extension to CalDAV that provides a fast way for a client to determine whether the contents of a
calendar collection may have changed." The mechanism: a `CS:getctag` WebDAV property, an opaque token
that "MUST change" whenever any child resource is added, modified or deleted; a client polls it with
a cheap `PROPFIND Depth:0`, and only falls through to a full `Depth:1` listing (and then an `ETag`
comparison per object) when the `ctag` differs from what it last saw.

The draft itself calls the mechanism deprecated in favor of RFC 6578 (confirmed by [WebSearch
results summarizing the current draft text](https://ece.uprm.edu/jmarrero/fedora_packaging/sabreDAV/1.7.6/BUILD/SabreDAV/docs/caldav-ctag.txt):
"The caldav-ctag-03 RFC was deprecated in 2015 in favor of support for the WebDAV Sync REPORT as
defined by RFC6578"), but it remains the fallback every provider surveyed here still exposes for
older clients — including servers that also support `sync-collection`, several of which (per
[python-caldav's live compatibility matrix](https://github.com/python-caldav/caldav/blob/master/caldav/compatibility_hints.py),
discussed in depth in §8) "simply us[e] the `DAV:sync-token` property value for the `getctag`
property value" for backwards compatibility. A Sync Backend that wants to support a self-hosted
server which genuinely doesn't implement RFC 6578 needs this fallback: `ctag` cheaply tells you *that*
something changed; a full per-object `ETag` comparison (or a fresh `Depth:1` listing) is then required
to work out *what*.

---

## 3. Authentication

None of the five CalDAV/CardDAV RFCs mandate an authentication scheme — RFC 4791/6352 are built on
plain WebDAV/HTTP, which leaves authentication to the transport. In practice every provider surveyed
requires HTTPS (RFC 6764 §6 itself prefers `https` for the well-known bootstrap) and HTTP Basic auth
carrying either the account password or, for three of the four providers, a **separate app-specific
password** rather than the account's real login credential.

| Provider | App-specific password required? | How provisioned |
|---|---|---|
| **iCloud** | **Yes, unconditionally.** Two-factor authentication is now mandatory for every Apple Account, and [Apple's own support documentation](https://support.apple.com/en-us/102654) states app-specific passwords are for when "apps made by developers other than Apple ask you to sign in to your Apple Account" — sign in at `account.apple.com` → Sign-In and Security → App-Specific Passwords → Generate. Apple's page frames the alternative as "authoriz[ing] the app using your Apple Account instead" for *supported* third-party apps (OAuth-style Sign in with Apple flows) — not an option available to a generic CalDAV client. Apple publishes **no dedicated CalDAV/CardDAV developer documentation at all**; the server hostnames (`caldav.icloud.com`, `contacts.icloud.com`) and the app-specific-password requirement for them are documented only indirectly (the general app-specific-password support article) or by third parties, not in an Apple developer guide the way Fastmail and Nextcloud publish theirs. |
| **Fastmail** | **Yes.** [Fastmail's own help article](https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords) states app passwords are required for "any non-Fastmail service such as your mail client or desktop calendar," created at Settings → Privacy & Security → Manage app passwords, with a "Mail, Contacts & Calendars" scope that covers IMAP/POP/SMTP, CardDAV and CalDAV together. Fastmail's [developer page](https://www.fastmail.com/dev/) separately documents OAuth 2.0 as the recommended path "for distributed applications," but for a Sync Backend authenticating as one specific user (not a public multi-tenant OAuth client Fastmail has vetted), the app-password path is what's actually available. Note per the same help article: **Basic-plan accounts cannot create app passwords at all** — those plans have no IMAP/SMTP/CalDAV/CardDAV access, only the web/app clients. |
| **Nextcloud** | **Effectively yes when 2FA is enabled** (Nextcloud recommends it regardless). Created in Settings → Security → Devices & Sessions → "Create new app password," authenticating with the Nextcloud username and that generated token rather than the login password. A live example of how load-bearing this is: [nextcloud/server issue #51898](https://github.com/nextcloud/server/issues/51898) reports CalDAV/CardDAV sync failing outright with HTTP 503 when an app password's file-system-access scope is disabled — i.e. Nextcloud's app passwords are independently *scoped*, and a Sync Backend needs the right scope, not merely any valid one. |
| **Radicale** | **No such concept exists.** Radicale's own [master documentation](https://radicale.org/master.html) describes a pluggable `[auth]` backend (`htpasswd`, `ldap`, `pam`, `oauth2`, `dovecot`, `remote_user`, or `none`/`denyall`) that authenticates directly against whatever credential store the operator configured — there is no separate "account login" surface for an app password to protect *instead of*. The htpasswd credential *is* the CalDAV/CardDAV credential. This is a real, sourced difference from the other three: a self-hosted Radicale instance has one password to provision, and it's the one the Sync Backend uses directly. |

---

## 4. Write semantics and conflict handling

### 4.1 Conditional `PUT` per RFC 4791 / RFC 6352

Both RFCs specify the same pattern for writes. RFC 4791 §5.3.2: "If the client intends to create a
new non-collection resource, such as a new VEVENT, the client SHOULD use the HTTP request header
`If-None-Match: *` on the `PUT` request" — this guarantees the write only succeeds if nothing already
exists at that URL, closing the race where two clients pick the same UID-derived filename. For
*updating* an existing object, the client instead sends `If-Match: <etag>` with the `ETag` it last
read, so the `PUT` only applies against the version it actually saw. RFC 4791 §5.3.4 makes `ETag`
support itself non-optional: "The `DAV:getetag` property MUST be defined and set to a strong entity
tag on all calendar object resources," and every `GET` "MUST contain an `ETag` response header
field." RFC 6352 mirrors this exactly for address objects (§6.3.2/§6.3.2.3): `If-Match` for updates,
`If-None-Match: *` for creates, `DAV:getetag` mandatory.

### 4.2 RFC 4918 — the underlying HTTP conditional-request machinery

**Primary source**: [RFC 4918, "HTTP Extensions for Web Distributed Authoring and Versioning
(WebDAV)"](https://www.rfc-editor.org/rfc/rfc4918). RFC 4918 §8.6 is where the *reason* for
conditional writes is spelled out in WebDAV's own terms: "ETags are required for the client to be
able to distinguish this case. Otherwise, the client is forced to ask the user whether to overwrite
the resource" — i.e. `ETag`-scoped `If-Match` exists specifically to make the lost-update problem
detectable rather than silent. RFC 4918 itself only briefly names "412 Precondition Failed" (§12.1)
and otherwise defers the actual `If-Match`/`If-None-Match` conditional-request semantics to HTTP
proper (originally RFC 2616, now RFC 9110 §13.1.1/13.1.2) — a **412** response is exactly the signal
a Sync Backend uses to detect that its cached copy of an object is stale: refetch the current `ETag`
and body, re-apply the local edit (or surface a conflict), and retry.

### 4.3 `Schedule-Tag`: a second, scheduling-aware conditional axis

RFC 6638 §3.2–3.3 (discussed fully in §5) layers a *second* conditional header on top of `ETag` for
any calendar object that carries an `ORGANIZER` (i.e. is a scheduling object): the server returns a
`Schedule-Tag` alongside `ETag`, which changes only when the object's *scheduling* state changes
(attendee replies, etc.) as distinct from `ETag`, which changes on any edit. Per
[python-caldav's compatibility notes](https://github.com/python-caldav/caldav/blob/master/caldav/compatibility_hints.py)
(`scheduling.schedule-tag.stable-partstat`), this is not universally implemented correctly even by
servers that otherwise support RFC 6638 — Cyrus is noted there as changing the `Schedule-Tag` even on
an attendee-`PARTSTAT`-only update, "violating RFC6638 section 3.2 which requires the tag to remain
stable." A Sync Backend that writes to scheduling objects should treat `Schedule-Tag` as best-effort
rather than load-bearing for conflict detection, and lean on plain `ETag`/`If-Match` as the mechanism
that's actually reliable across providers.

---

## 5. Scheduling: RFC 6638 server-side vs. client-composed iTIP-over-email

### 5.1 What RFC 6638 specifies

**Primary source**: [RFC 6638, "Scheduling Extensions to CalDAV"](https://www.rfc-editor.org/rfc/rfc6638)
(authored by C. Daboo, Apple Inc., and B. Desruisseaux, Oracle — i.e. co-authored by the Apple
engineer who also wrote the ctag draft above). Its own framing: "This specification defines a
client/server scheduling protocol, where the server is made responsible for sending scheduling
messages and processing incoming scheduling messages." Two new collections carry this: a
**schedule-inbox**, into which the server delivers incoming iTIP `REQUEST`/`REPLY`/`CANCEL` messages
as it processes them (§4), and a **schedule-outbox**, which the client `POST`s an iTIP message to in
order to have the *server* fan it out to attendees (§3, §5). §5 also defines a `free-busy-query` POST
to the outbox — distinct from RFC 4791 §7.10's own `free-busy-query` REPORT sent directly to a
calendar collection; both exist, and support for one doesn't imply support for the other (see the
`tsdav` findings in §8). RFC 6638 is explicit that it's meant to interoperate with, not replace,
plain email-based scheduling: "this specification is compatible with servers being able to send or
receive scheduling messages with 'external' users (e.g., using the iCalendar Message-Based
Interoperability Protocol (iMIP))." That is, RFC 6638 covers *server-to-server-on-the-same-CalDAV-
instance* (or cross-instance where both speak it) scheduling; a message crossing to a user whose
calendar isn't reachable this way still has to go out as iMIP over SMTP, exactly the mechanism the
map's own charting notes assume for Local calendars ("Local calendars… send their own iMIP invites
through one of the User's Mail Accounts").

### 5.2 Who actually implements it

RFC 6638 assumes near-universal adoption ("all new CalDAV implementations will support it by
default") but doesn't name a fallback for servers that don't — that's left to the client. The most
concrete, testable evidence available is [python-caldav's `compatibility_hints.py`](https://github.com/python-caldav/caldav/blob/master/caldav/compatibility_hints.py),
a compatibility database the library's maintainers actively probe against live Docker instances of
each server (dated observations, e.g. "Probed 2026-08-26 against the docker test server," appear
throughout). Its `scheduling` feature is detected "via the presence of `calendar-auto-schedule` in
the DAV response header" and **defaults to `full` support** unless a server explicitly pins it
otherwise — meaning every row below is a real, observed pin, not an assumption:

| Server | `scheduling` (RFC 6638) | Notes from the same file |
|---|---|---|
| **Apple's own CalendarServer** (`ccs`, the open-sourced code behind iCloud's calendar service) | Full — `scheduling.mailbox.inbox-delivery: True`, `scheduling.auto-schedule: True` | Not directly iCloud itself (untestable in this matrix), but the same company and the same RFC's own lead author; the strongest evidence available that iCloud implements RFC 6638, short of testing production iCloud directly. |
| **DAViCal** | Full auto-schedule | Comment: "DAViCal delivers iTIP notifications to the attendee inbox AND auto-schedules into their calendar." |
| **Nextcloud** (SabreDAV-based) | Full auto-schedule (only `schedule-tag` pinned unstable) | Comment: "Observed with Nextcloud 33: server delivers iTIP notification to the inbox AND auto-schedules into the attendee's calendar." Consistent with [sabre/dav's own wiki history](https://sabre.io/dav/clients/ical/): "Since version 2.1, SabreDAV has support for scheduling" (added specifically because pre-Mavericks iCal "assume[d] that any CalDAV server supports CalDAV-scheduling features… if this is not supported, no emails for these types of actions will be sent"). |
| **Cyrus IMAP** (also serves CalDAV) | Full auto-schedule, cross-user | Comment: "Cyrus implements server-side automatic scheduling: for cross-user invites, the server both auto-processes the invite into the attendee's calendar AND delivers an iTIP notification copy to the attendee's schedule-inbox." Also flagged: Cyrus violates RFC 6638 §3.2's `Schedule-Tag` stability rule on `PARTSTAT`-only updates (§4.3 above). |
| **SOGo** | `freebusy-query: ungraceful`; general scheduling support unclear from the file (no top-level `scheduling` pin found, `mailbox.inbox-delivery: False` noted historically) | Long list of open SOGo bugtracker links kept as comments (`bugs.sogo.nu/view.php?id=5163`, `5282`, `5693`, `5694`) around sync-token and search timing, suggesting a rockier implementation generally. |
| **Radicale** | **Explicitly `unsupported`** | Pinned directly: `"scheduling": {"support": "unsupported"}`. Confirms §7.4 below — a self-hosted Radicale gives a Sync Backend no server-side scheduling at all. |
| **Xandikos** | **Explicitly `unsupported`** | Same pin. Another common self-hosted target with no RFC 6638 support. |

**Fastmail** doesn't have an active automated profile in that same matrix (no live CI target), but a
separate, directly attributable primary source closes the gap: [`draft-ietf-calext-caldav-scheduling-controls`](https://datatracker.ietf.org/doc/html/draft-ietf-calext-caldav-scheduling-controls),
an active IETF Internet-Draft proposing new `Scheduling` and `Schedule-User-Address` headers to give
*finer* control over RFC 6638's automatic-scheduling behavior (e.g. suppressing notifications during
a data-recovery import), is edited by **Bron Gondwana at Fastmail**. A vendor doesn't propose
refinements to a mechanism it hasn't already shipped — this is strong, attributable evidence Fastmail
runs RFC 6638 scheduling in production, even without a live test-matrix entry to point to directly.

**iCloud**, similarly, has no live entry (Apple's production iCloud can't be pointed at automated
CI), but the same reasoning applies more directly here than for Fastmail: RFC 6638 is co-authored by
an Apple engineer, and Apple's own open-sourced `ccs` CalendarServer — tested live in the same
compatibility matrix — fully implements `auto-schedule` and `inbox-delivery`. Community reports (e.g.
[sabre/dav's iCal client notes](https://sabre.io/dav/clients/ical/)) describe pre-2013 macOS Calendar
relying on exactly this "the server emails invitations" behavior against iCloud, which only makes
sense if iCloud's server side actually does it.

### 5.3 What "the client sends its own iTIP" means in practice

For the two servers confirmed **not** to implement RFC 6638 (Radicale, Xandikos, and by strong
implication any bare-bones self-hosted WebDAV target the ticket frames as "a self-hosted WebDAV
host"), a Sync Backend gets no help composing or delivering invitations: it must itself build the
iTIP `METHOD:REQUEST`/`REPLY`/`CANCEL` `VCALENDAR` payloads per [RFC 5546](https://www.rfc-editor.org/rfc/rfc5546)
and mail them out over SMTP as a `text/calendar` MIME part — precisely the mechanism the map's own
charting notes already commit to for **Local** calendars ("Local calendars… send their own iMIP
invites through one of the User's Mail Accounts"). The practical consequence for this ticket's Sync
Backend: **scheduling can't be a single code path**. It needs to detect, per connected CalDAV server,
whether RFC 6638 is present (the `calendar-auto-schedule` DAV capability header, or simply probing
whether a schedule-outbox exists under the principal) and fall back to composing and mailing its own
iTIP the same way it already has to for Local calendars when it isn't.

---

## 6. CardDAV: the same bones, a thinner scheduling story

**Primary source**: [RFC 6352, "CardDAV: vCard Extensions to Web Distributed Authoring and
Versioning (WebDAV)"](https://www.rfc-editor.org/rfc/rfc6352).

Discovery is structurally identical to CalDAV — `.well-known/carddav` (RFC 6764), `current-user-
principal` (RFC 5397), then `CARDDAV:addressbook-home-set` (§7.1.1, quoted in §1.3 above). Two
mandatory reports mirror CalDAV's: `CARDDAV:addressbook-query` (§8.6, filtered search) and
`CARDDAV:addressbook-multiget` (§8.7, batch-fetch by URI) — the vCard equivalents of
`calendar-query`/`calendar-multiget`. Conditional-write semantics are the same `If-Match`/
`If-None-Match`/mandatory-`ETag` pattern (§6.3.2/§6.3.2.3, quoted in §4.1).

Notably, **RFC 6352 (published March 2011) does not mention RFC 6578 (published March 2012) or any
change-detection mechanism at all** — CardDAV predates the WebDAV sync REPORT, so it never needed to
adopt it explicitly. In practice this doesn't matter: `sync-collection` is defined purely at the
generic `DAV:` level, so any server that supports it for calendars supports it identically for
address books — which is exactly how `tsdav`'s implementation works (§8): the same `syncCollection`
function is shared by both, branching only on whether to request `CALDAV:calendar-data` or
`CARDDAV:address-data` as the payload property. There is no CardDAV equivalent of RFC 6638 at all —
address books have no scheduling concept — so this whole axis (§5) is CalDAV-only.

---

## 7. Known quirks per provider

### 7.1 iCloud

Genuinely the least-documented of the four from Apple's own side — there is no Apple developer guide
for CalDAV/CardDAV at all, only the general-purpose app-specific-password support article (§3) and
whatever server hostnames third parties have reverse-engineered. Specific, sourced quirks:

- **Partitioned hostnames.** The `calendar-home-set` PROPFIND against `caldav.icloud.com` redirects
  the client to an account-specific, numbered partition host (`pNN-caldav.icloud.com`) — a real
  observation repeatedly surfaced in developer write-ups (e.g. searched via the Nylas CLI guide and
  multiple independent Q&A threads). A client that hardcodes a discovered partition URL for one
  account will fail against another; the discovery chain in §1 has to be walked per-account, every
  time, not cached across users.
- **No journal, no server-side free/busy, no recurring events over CalDAV, no CalDAV-visible
  tasks** — all four independently reported in [python-caldav's tracking issue #3, "Icloud not fully
  supported"](https://github.com/python-caldav/caldav/issues/3): "iCloud doesn't support journal
  entries" (and attempting one "threw a 500 internal server error"); "iCloud doesn't support
  freebusy-requests"; "All test code dealing with recurring events have been disabled" against
  iCloud; iCloud's task system exists but "cannot be accessed through the CalDAV interface." These
  match the same file's dormant `icloud` compatibility profile (kept as a comment block since iCloud
  can't be targeted by CI): `no_journal`, `no_freebusy_rfc4791`, `no_recurring`, `no_todo`,
  `propfind_allprop_failure`, `get_object_by_uid_is_broken`, `sticky_events` (deleting a calendar
  doesn't reliably free its objects), and `duplicate_in_other_calendar_with_same_uid_breaks` (the
  same UID can't exist on two calendars, unlike RFC 4791's silence on cross-calendar UID scoping).
- **No dedicated developer documentation, only the app-specific-password requirement** — see §3.
- **`allprop` PROPFIND is unreliable** — flagged separately in the same issue, meaning a client
  should always request specific properties rather than relying on a wildcard `PROPFIND`.

### 7.2 Fastmail

Fastmail is comparatively well-behaved and, unusually among the four, well-documented by the vendor
itself (§3's server-name and app-password articles both come straight from Fastmail's own help
center). Sourced quirks, from [python-caldav's historical `fastmail` profile](https://github.com/python-caldav/caldav/blob/master/caldav/compatibility_hints.py)
(kept as a comment block, not currently CI-tested, but a maintained record of past behavior):
`duplicates_not_allowed` and `duplicate_in_other_calendar_with_same_uid_breaks` (same UID-uniqueness
quirk as iCloud); `no_todo` (no CalDAV-visible VTODO); `sticky_events`; a specifically-named
`fastmail_buggy_noexpand_date_search` bug ("the 'blissful anniversary' recurrent example event is
returned when asked for a no-expand date search for some timestamps covering a completely different
date" — a real recurrence-expansion defect, not a design choice); `combined_search_not_working`;
`text_search_is_exact_match_sometimes`; `rrule_takes_no_count`; `isnotdefined_not_working`. On the
positive side, Fastmail's Bron Gondwana authoring an active IETF draft refining RFC 6638 (§5.2) is
the strongest sourced evidence any surveyed provider actually implements CalDAV scheduling in
production, and Fastmail's manual CardDAV URL for personal contacts follows a documented,
predictable shape (`https://carddav.fastmail.com/dav/addressbooks/user/<email>/Default`, per §3).

### 7.3 Nextcloud

The most standards-compliant of the self-hostable options in this survey, being SabreDAV underneath
(the same library sabre.io's own wiki documents scheduling support history for). Sourced quirks, from
the same live-tested `nextcloud` profile:

- **Calendar deletion goes to a trashbin, not gone.** "Deleting a recently created calendar fails"
  (pinned `fragile`) and, separately: "deleting a calendar moves it to a trashbin, thrashbin has to be
  manually 'emptied' from the web-ui before the namespace is freed up" — a delete-then-recreate at the
  same name/URL doesn't give a clean slate the way RFC 4791 leaves ambiguous.
- **`principal-search` is `ungraceful`** — the RFC-optional principal-search REPORT errors rather
  than cleanly declining.
- **Open-ended time-range searches are `broken`** for one specific shape
  (`search.time-range.open.start.duration`).
- **Rate limits bite integration testing and real usage alike**: the file's own comment warns "be
  aware that nextcloud by default have different rate limits, including how often a user is allowed
  to create a new calendar. This may break test runs badly" — a concrete operational constraint for a
  Sync Backend doing bulk initial sync across many calendars.
- **A 2021-era `@`-in-username percent-encoding workaround has since become unnecessary**: the file's
  own comment records probing this again in 2026 and finding both the raw and percent-encoded forms
  resolve fine against a modern Nextcloud, "retir[ing] a hack from 2021" — a reminder that some
  provider quirks are release-dependent and worth periodically re-verifying rather than assuming
  permanent.
- **A historical UID-reuse bug is documented and linked upstream**: "After deleting an event, the
  server allows creating a new event with the same UID. When 'broken', the server keeps deleted
  events in a trashbin with a soft-delete flag, causing unique constraint violations on UID reuse,"
  citing [nextcloud/server#30096](https://github.com/nextcloud/server/issues/30096) directly.
- **Scheduling is real and reasonably solid**: full `auto-schedule` and inbox-delivery confirmed
  against Nextcloud 33 (§5.2); only `schedule-tag` stability is flagged as an issue, not the core
  mechanism.
- App-password scoping is load-bearing, not cosmetic: [nextcloud/server#51898](https://github.com/nextcloud/server/issues/51898)
  documents CalDAV/CardDAV failing with HTTP 503 specifically when an app password's file-access
  scope is disabled — a Sync Backend's provisioning instructions need to tell the user which scope to
  grant, not just "create any app password."

### 7.4 Radicale

The lightest-weight of the four, and its own documentation is candid about the trade-off:
[Radicale's master documentation](https://radicale.org/master.html) states plainly "CalDAV and
CardDAV are not perfect protocols… we decided not to implement the whole standard but just enough to
understand some of its client-side implementations" — an explicit, vendor-acknowledged partial
implementation, not a hidden gap. Concretely, from the same live-tested compatibility profile:

- **No scheduling at all** — `"scheduling": {"support": "unsupported"}`, pinned directly (§5.2). A
  Sync Backend talking to Radicale must always fall back to client-composed iTIP-over-email for any
  invite.
- **No principal-search** — `"principal-search": {"support": "unsupported"}`.
- **Case-insensitive text search only** — `"search.text.case-sensitive": {"support": "unsupported"}`.
- **Recurrence expansion is inconsistent for tasks**: `search.recurrences.includes-implicit.todo.pending`
  is pinned `fragile` with the note "inconsistent results between runs," and
  `search.recurrences.expanded.todo` is unsupported outright (event recurrence expansion works fine —
  only the VTODO variant is shaky).
- **No app-specific-password concept** (§3) — its pluggable `[auth]` backend authenticates directly
  against whatever credential store is configured, with `denyall` as the default since v3.5.0 (i.e. a
  fresh install refuses everyone until an operator explicitly configures a real backend — a
  self-hosting-specific setup step worth calling out in any onboarding flow the Sync Backend offers).
- **`.well-known` isn't handled by Radicale itself** — nothing in its documentation describes serving
  `/.well-known/caldav|carddav`; that redirect, if wanted, is left to whatever reverse proxy sits in
  front of it (a real gap for the "self-hosted WebDAV host" case specifically, since RFC 6764's
  bootstrap assumes the server itself answers that path).

---

## 8. TypeScript client library landscape

### 8.1 `tsdav`

**Repository**: [github.com/natelindev/tsdav](https://github.com/natelindev/tsdav), MIT-licensed,
355 GitHub stars (checked 2026-09-07). Actively maintained: latest release **v2.3.2**, published the
**same day** this research was conducted, with 8+ releases in the preceding several months and only
**one open issue** across the whole repository — every other issue in the tracker (searched for
`sync-collection`, `scheduling`, `icloud`, and browsing the full closed-issue history) is closed, most
with a maintainer response and a fix landed in a subsequent point release.

**RFC coverage, verified directly against the source** (not just the README):

- **RFC 6578 `sync-collection`** is genuinely implemented — `src/collection.ts`'s `syncCollection`
  function builds the exact `sync-collection`/`sync-token`/`sync-level` REPORT body RFC 6578 §3.2
  specifies, and `smartCollectionSync` picks it automatically ("webdav" method) whenever the target
  collection advertises `syncCollection` in its `supported-report-set`, falling back to plain `ctag`
  polling ("basic" method) otherwise — i.e. it already implements both halves of §2 above, including
  the fallback, without the caller having to choose.
- **`If-Match`/`If-None-Match` conditional writes** are implemented in `src/collection.ts` and used
  by the calendar/vCard `create`/`update` helpers (`'If-None-Match': '*'` on create,
  `'If-Match': etag` on update) — matching §4.1's RFC-specified pattern exactly.
- **RFC 4791 §7.10 `free-busy-query`** (the calendar-collection REPORT variant, not the RFC 6638 §5
  schedule-outbox POST variant) is implemented (`freeBusyQuery` in `src/calendar.ts`). **No RFC 6638
  scheduling primitives exist anywhere in the source** — a repository-wide code search for
  `schedule-outbox`/`schedule` in `.ts` files under the library returns nothing. A Sync Backend using
  `tsdav` gets zero help with server-side scheduling (§5) and must hand-roll the schedule-outbox POST
  and schedule-inbox parsing itself, or bypass RFC 6638 entirely and compose iTIP-over-email as §5.3
  describes.
- **Real integration test coverage against live-shaped servers**: the source tree includes dedicated
  integration test suites (`src/__tests__/integration/`) for **Apple (iCloud), Baïkal, DAViCal,
  Fastmail, Google, Nextcloud, and Zoho** — i.e. this isn't a library tested only against a mock; it
  has provider-specific test fixtures for three of this ticket's four named providers directly
  (missing only Radicale from that list, though CardDAV/CalDAV sync is exercised generically).
- **The one currently-open issue** ([#278](https://github.com/natelindev/tsdav/issues/278)) is itself
  a well-diagnosed, precisely-scoped RFC-compliance edge case: `collectionQuery` throws on a
  `calendar-query` REPORT where the server answers `207` with a nested collection-level `404` instead
  of an empty `<D:multistatus/>` (citing [RFC 4791 §7.8](https://www.rfc-editor.org/rfc/rfc4791.html#section-7.8)
  directly), reproduced against a real server (Stalwart, pre-0.16.12) with a linked upstream bug
  report — the kind of issue a healthy, actively-used library accumulates, not a sign of neglect.
- **One resolved issue worth flagging as a caution, not a disqualifier**: [#200](https://github.com/natelindev/tsdav/issues/200),
  `syncCalendars` marking unchanged calendars as `updated` because a `ctag`/`syncToken` comparison
  coerced `number` against `string` and always failed — reported against a real integration (Google),
  fixed by the maintainer within the same week, landed in v2.1.1. The type mismatch it exposes (some
  providers return `ctag` as a numeric-looking string, `tsdav`'s internal comparison wasn't always
  normalizing it) is a concrete reminder that `ctag`/`etag` comparisons anywhere in a Sync Backend
  should compare as strings unconditionally, regardless of which library is used.

### 8.2 Alternatives surveyed

- **`ts-caldav`** ([github.com/KlautNet/ts-caldav](https://github.com/KlautNet/ts-caldav)) — a
  younger, smaller library (28 stars, created December 2024, one open issue, last push August 2026).
  Its own README lists iCloud, Fastmail, Google, GMX, Yahoo, Nextcloud, Baikal and Radicale as "Known
  Working Servers," but its own **Limitations** section states plainly: "No WebDAV sync-token support
  yet; synchronization currently uses `getctag` plus ETag diffing" — i.e. it never implements RFC 6578
  at all, only the pre-RFC-6578 fallback from §2.3. It is **CalDAV-only** (no CardDAV/address-book
  support whatsoever), so it can't answer half of what this ticket asks for on its own. Worth watching,
  not worth building on today.
- **`calcom/tsDAV`** — a fork of `tsdav` by Cal.com, surfaced in search results as a plausible
  "production usage by a known company" signal. Checked directly: it's a **stale fork, last pushed
  2021-09-14**, 11 stars, and a repository-wide search of Cal.com's own main `cal.com` monorepo for a
  `tsdav` dependency in any `package.json` returns **nothing** — i.e. this fork does not appear to be
  in Cal.com's current production dependency graph at all. Not a live signal either way; disregarded.
- No other actively maintained, general-purpose TypeScript CalDAV+CardDAV client library surfaced in
  this research beyond these two.

### 8.3 Verdict

**`tsdav` is trustworthy enough to build a production Sync Backend on for CalDAV *and* CardDAV
discovery, sync-collection change detection, and conditional writes** — its implementation of exactly
the mechanisms §1, §2 and §4 describe is correct against the RFC text, exercised by real integration
tests against three of the four named providers, actively maintained (a release the same day this
research ran), and its open-issue history shows a maintainer who responds, diagnoses precisely against
the RFC, and ships fixes.

**It is not sufficient on its own for RFC 6638 scheduling** — that surface doesn't exist in the
library at all, so §5's scheduling story (detecting `calendar-auto-schedule` support, POSTing to a
schedule-outbox, parsing a schedule-inbox, or falling back to composing iTIP-over-email) has to be
hand-rolled regardless of which client library is chosen. Given that `tsdav` already gets the harder,
more error-prone XML/REPORT plumbing right (sync-token bookkeeping, multistatus parsing, conditional
headers), the honest trade-off is: **use `tsdav` for the parts it does well, and hand-roll the RFC 6638
schedule-outbox/schedule-inbox POST/PROPFIND calls directly** (a much smaller, better-isolated surface
than reimplementing sync-collection or addressbook-query from scratch would be) — not "hand-roll
everything" and not "trust one library for the whole feature."

---

## Sources consulted

- [RFC 4791 — Calendaring Extensions to WebDAV (CalDAV)](https://www.rfc-editor.org/rfc/rfc4791)
- [RFC 6352 — CardDAV: vCard Extensions to WebDAV](https://www.rfc-editor.org/rfc/rfc6352)
- [RFC 6578 — Collection Synchronization for WebDAV](https://www.rfc-editor.org/rfc/rfc6578)
- [RFC 6638 — Scheduling Extensions to CalDAV](https://www.rfc-editor.org/rfc/rfc6638)
- [RFC 5397 — WebDAV Current Principal Extension](https://www.rfc-editor.org/rfc/rfc5397)
- [RFC 6764 — Locating Services for CalDAV and CardDAV](https://www.rfc-editor.org/rfc/rfc6764)
- [RFC 4918 — HTTP Extensions for WebDAV](https://www.rfc-editor.org/rfc/rfc4918)
- [RFC 5546 — iCalendar Transport-Independent Interoperability Protocol (iTIP)](https://www.rfc-editor.org/rfc/rfc5546)
- [Apple/ccs-calendarserver: `caldav-ctag.txt`](https://github.com/apple/ccs-calendarserver/blob/master/doc/Extensions/caldav-ctag.txt)
- [Apple support: use app-specific passwords](https://support.apple.com/en-us/102654)
- [Fastmail: Server names and ports](https://www.fastmail.help/hc/en-us/articles/1500000278342-Server-names-and-ports)
- [Fastmail: App passwords](https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords)
- [Fastmail: API/developer documentation](https://www.fastmail.com/dev/)
- [draft-ietf-calext-caldav-scheduling-controls (Bron Gondwana, Fastmail)](https://datatracker.ietf.org/doc/html/draft-ietf-calext-caldav-scheduling-controls)
- [Nextcloud: Calendar / CalDAV administration manual](https://docs.nextcloud.com/server/stable/admin_manual/groupware/calendar.html)
- [nextcloud/server issue #51898 — CalDAV/CardDAV sync fails with app password when file access is disabled](https://github.com/nextcloud/server/issues/51898)
- [nextcloud/server issue #30096 — UID reuse after trashbin delete](https://github.com/nextcloud/server/issues/30096)
- [Radicale master documentation](https://radicale.org/master.html)
- [sabre/dav: Building a CalDAV client](https://sabre.io/dav/building-a-caldav-client/)
- [sabre/dav: CalDAV/CardDAV integration guide](https://sabre.io/dav/caldav-carddav-integration-guide/)
- [sabre/dav: iCal client notes](https://sabre.io/dav/clients/ical/)
- [python-caldav/caldav: `compatibility_hints.py`](https://github.com/python-caldav/caldav/blob/master/caldav/compatibility_hints.py)
- [python-caldav/caldav issue #3 — "Icloud not fully supported"](https://github.com/python-caldav/caldav/issues/3)
- [github.com/natelindev/tsdav](https://github.com/natelindev/tsdav) (README, source under `src/`, issues #200 and #278, releases)
- [github.com/KlautNet/ts-caldav](https://github.com/KlautNet/ts-caldav)
- [github.com/calcom/tsDAV](https://github.com/calcom/tsDAV) (stale fork, checked for currency only)
