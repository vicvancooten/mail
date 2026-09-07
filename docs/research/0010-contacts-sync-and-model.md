# Google People API sync and a Contact model across People, Graph and vCard

Research for [issue #164, "Research: Google People API sync and a Contact model across People, Graph and vCard"](https://github.com/vicvancooten/mail/issues/164) (child of [#158, wayfinder map: Hub Apps: Contacts, Calendar, Tasks, Notes](https://github.com/vicvancooten/mail/issues/158)).

Question: what does syncing Google Contacts into the Sync Backend take, and what shared Contact
data model covers Google, Microsoft Graph and vCard 4 without lossy round-trips? This document
establishes, from primary sources only (the Google People API reference, the Microsoft Graph
reference, and RFC 6350 itself), the sync mechanics, scopes, field coverage, write-back semantics,
photo handling and quotas for Google's People API; the equivalent shape for Microsoft Graph's
`contact` resource; the vCard 4.0 property set; a field-family cross-mapping table across all
three; and — the most load-bearing part — an explicit list of what a shared Contact model must
drop or approximate on a round trip.

This is research only: no feature code, no model implementation. Map #158 records Contacts as
"preferred" for upstream sync, Google first, CalDAV/CardDAV second, Microsoft Graph last — but
this ticket specifically asks for Graph mapped now too, since the *model* has to hold all three
shapes even though the *sync backend* implementation order defers Graph.

---

## 1. Google People API

### 1.1 Sync: `people.connections.list`, syncToken, expiry

Source: [`people.connections.list` reference](https://developers.google.com/people/api/rest/v1/people.connections/list).

- **Resource scope**: `resourceName` is "Required. The resource name to return connections for.
  Only `people/me` is valid." — `connections.list` only ever syncs the signed-in user's own
  contacts, not an arbitrary person.
- **Required field mask**: `personFields` is "Required. A field mask to restrict which fields on
  each person are returned," comma-separated (e.g. `names,emailAddresses,phoneNumbers`). There is
  no "return everything" default — every sync request must enumerate the fields it wants.
- **Pagination**: `pageSize` — "Optional. The number of connections to include in the response.
  Valid values are between 1 and 1000, inclusive. Defaults to 100 if not set or set to 0." Paging
  uses `pageToken` / response `nextPageToken`, and "When paginating, all other parameters provided
  to `people.connections.list` must match the first call that provided the page token."
- **Sync token flow**:
  - `requestSyncToken` (boolean): "Whether the response should return `nextSyncToken` on the last
    page of results. It can be used to get incremental changes since the last request by setting
    it on the request `syncToken`." Set it `true` on the request that walks the *full* result set;
    the last page then carries `nextSyncToken`.
  - `syncToken`: "Optional. A sync token, received from a previous response `nextSyncToken` ...
    Provide this to retrieve only the resources changed since the last request." Same
    match-the-first-call constraint as `pageToken`: "When syncing, all other parameters provided to
    `people.connections.list` must match the first call that provided the sync token" — i.e. the
    `personFields` mask used for the initial full sync must be reused verbatim for every delta
    call built on its token, or the token is invalid for that request shape.
  - **Expiry**: "Sync tokens expire 7 days after the full sync." This is the concrete number the
    ticket asked for — a Sync Backend must do a full `connections.list` walk to mint a fresh token
    at least once a week, or risk falling outside the window on any account that goes quiet longer
    than that (vacation, disabled sync, etc.).
  - **Expired-token error**: "A request with an expired sync token will get an error with an
    `google.rpc.ErrorInfo` with reason `EXPIRED_SYNC_TOKEN`." The reference page does not spell
    out the numeric HTTP status alongside this (see Source-access note in §7) — only the
    structured `ErrorInfo` reason is documented. Guidance: "In the case of such an error clients
    should make a full sync request without a `syncToken`" — i.e. treat it as "start over," not as
    a transient error to retry.
  - Deletions surface as normal Person resources in the delta with `metadata.deleted: true` (see
    §1.3), not as a separate deletions list.
- **Sort order**: `sortOrder` enum — `LAST_MODIFIED_ASCENDING` (default),
  `LAST_MODIFIED_DESCENDING`, `FIRST_NAME_ASCENDING`, `LAST_NAME_ASCENDING`.
- **Response shape**: `connections[]` (Person resources), `nextPageToken`, `nextSyncToken`,
  `totalItems`.

**Practical sync loop for the Sync Backend**: full sync with `requestSyncToken=true` and a fixed
`personFields` mask, paging with `pageToken` until the last page yields `nextSyncToken`; store that
token per-account; on the next poll, call again with `syncToken` set (same `personFields`) and
apply only the returned deltas; if a call ever returns `EXPIRED_SYNC_TOKEN`, drop the stored token
and re-run a full sync. A full-sync floor of once every 7 days is required regardless, to keep the
token from ever going stale on a low-traffic account.

### 1.2 OAuth scopes

Source: the People API's own [OAuth2 discovery document](https://people.googleapis.com/$discovery/rest?version=v1)
(`auth.oauth2.scopes`), which is Google's own machine-readable, authoritative scope list for this
API — the generic [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes)
page lists the same scopes across all Google APIs but its "People API" section did not fully
render through fetching (see §7).

| Scope | Description (verbatim) |
|---|---|
| `https://www.googleapis.com/auth/contacts` | "See, edit, download, and permanently delete your contacts" |
| `https://www.googleapis.com/auth/contacts.readonly` | "See and download your contacts" |
| `https://www.googleapis.com/auth/contacts.other.readonly` | "See and download contact info automatically saved in your \"Other contacts\"" |
| `https://www.googleapis.com/auth/directory.readonly` | "See and download your organization's Google Workspace directory" |
| `https://www.googleapis.com/auth/user.emails.read` | "See and download all of your Google Account email addresses" |
| `https://www.googleapis.com/auth/user.phonenumbers.read` | "See and download your personal phone numbers" |
| `https://www.googleapis.com/auth/user.addresses.read` | "View your street addresses" |
| `https://www.googleapis.com/auth/user.birthday.read` | "See and download your exact date of birth" |
| `https://www.googleapis.com/auth/user.gender.read` | "See your gender" |
| `https://www.googleapis.com/auth/user.organization.read` | "See your education, work history and org info" |
| `https://www.googleapis.com/auth/userinfo.profile` / `userinfo.email` | Basic profile / primary email, not contacts-specific |

For a full read-write contacts sync (`connections.list` + write-back via `updateContact` /
`updateContactPhoto`), the Sync Backend needs `contacts` (read-write) — `contacts.readonly` is
insufficient once write-back exists. `contacts.other.readonly` is a distinct, separate grant for
Google's auto-collected "Other contacts" (people mailed but never explicitly saved) — relevant if
Wicket's "Correspondents" concept (map #158: "people you've mailed") is ever backed by Google's own
equivalent rather than derived purely from local mail history. `directory.readonly` is
Workspace-domain-only and out of scope for a personal/consumer contacts sync.

### 1.3 Person resource: field coverage

Source: [Person resource reference](https://developers.google.com/people/api/rest/v1/people).

Core identity: `resourceName` ("An ASCII string in the form of `people/{person_id}`"), `etag`
("The HTTP entity tag of the resource. Used for web cache validation"), and `metadata`
(`sources[]`, each with `type` — `ACCOUNT | PROFILE | DOMAIN_PROFILE | CONTACT | OTHER_CONTACT |
DOMAIN_CONTACT` — plus per-source `etag` and `updateTime`; `deleted` boolean surfaces tombstones in
sync deltas; `previousResourceNames[]` and `linkedPeopleResourceNames[]` track merges).

Relevant field families and their shapes:

- **names[]**: `givenName`, `familyName`, `middleName`, `honorificPrefix`, `honorificSuffix`, plus
  `displayName`/`displayNameLastFirst`/`unstructuredName` and a full parallel set of `phonetic*`
  fields. Structured, repeatable (though in practice contacts have one canonical name).
- **emailAddresses[]** / **phoneNumbers[]**: `value`, `type`, `formattedType`; phone numbers also
  carry `canonicalForm` (E.164). List operations cap these at 100 entries each ("For
  `people.connections.list` and `otherContacts.list` the number is limited to 100" — use
  `getBatchGet` for the full set on the rare contact that exceeds it).
- **addresses[]**: `poBox`, `streetAddress`, `extendedAddress`, `city`, `region`, `postalCode`,
  `country`, `countryCode`, `formattedValue`, `type`, `formattedType` — a superset of vCard's
  7-component `ADR` (adds a separate ISO country code and a pre-formatted display string).
- **organizations[]**: `name`, `department`, `title`, `jobDescription`, `type` (work/school),
  `current` (boolean), `startDate`/`endDate`, plus `symbol`, `domain`, `location`, `costCenter`,
  `fullTimeEquivalentMillipercent`. **Multiple entries are concurrent, current organizations are
  representable** — nothing forces only one `current: true` entry.
- **biographies[]**: free text/HTML notes. "This field is a singleton for contact sources" — i.e.
  despite being an array in the schema, a contact-sourced Person effectively has at most one.
- **birthdays[]**: a structured `date` (Google's `Date` message: `year`, `month`, `day`, where
  **year is optional** — a year of `0` or the field omitted represents "no year"), plus a
  deprecated free-form `text`. "Clients should always set the `date` field when mutating
  birthdays."
- **photos[]**: `url` (supports a `sz={size}` sizing suffix per the
  [Image Sizing guide](https://developers.google.com/people/image-sizing) — `=s400`, `=w400`,
  `=h100-c` etc., no documented default/max pulled from that page), `default` (boolean, whether
  it's Google's generated placeholder). Output-only via `people.get`/`connections.list` — see §1.4
  for how photos are actually written.
- **memberships[]**: `contactGroupMembership.contactGroupResourceName` — Google's contact groups
  are a genuine many-to-many join (a contact can belong to several groups/labels at once), and
  "Any contact group membership can be removed, but only user group or `myContacts` or `starred`
  system group memberships can be added" — some system groups are membership-read-only.
- **relations[]**: `person` (free-text name, not a resourceName reference), `type` (spouse, child,
  mother, father, parent, sibling, friend, relative, domesticPartner, manager, assistant,
  referredBy, partner, …). Not a link to another Person resource — just a labeled string.
- **nicknames[]**, **urls[]**, **imClients[]**, **userDefined[]** (arbitrary user key/value pairs),
  **clientData[]** (arbitrary client key/value pairs, "Duplicate keys and values are allowed"),
  **events[]** (anniversaries etc.), **occupations[]**, **interests[]**, **locales[]** round out
  the schema.
- **FieldMetadata** on every value: `primary` ("True if the field is the primary field for all
  sources. Each person will have at most one field with `primary` set to true"), `sourcePrimary`,
  `verified`, and a `source` back-reference — this is how Google represents "the canonical email"
  among several, per-source.

### 1.4 Write-back: `updateContact`, `updatePersonFields`, etag

Source: [`people.updateContact` reference](https://developers.google.com/people/api/rest/v1/people/updateContact).

- `PATCH https://people.googleapis.com/v1/{person.resourceName=people/*}:updateContact`.
- `updatePersonFields` (required query param): "A field mask to restrict which fields on the
  person are updated" — comma-separated, drawn from a fixed writable set (`addresses`,
  `biographies`, `birthdays`, `emailAddresses`, `memberships`, `names`, `organizations`,
  `phoneNumbers`, `relations`, `urls`, `userDefined`, etc.). This is distinct from the `personFields`
  query param, which only controls what the *response* echoes back.
- **Etag concurrency**: "The server returns a 400 error with reason `failedPrecondition` if
  `person.metadata.sources.etag` is different than the contact's etag" — i.e. write-back is
  optimistic-concurrency-gated: fetch the Person (getting its current etag), PATCH with that etag
  embedded in the request body's `metadata.sources`, and a stale etag is rejected rather than
  silently overwritten. "If making sequential updates to the same person, the etag from the
  `updateContact` response should be used" for the next write, chaining etags rather than
  re-fetching each time.
- **Singleton-field constraint**: biographies, birthdays, genders and names are "singleton" fields
  server-side — sending more than one value for these in an update is rejected rather than
  appending.
- **contactGroups (memberships)** have a partial write path through `updateContact`'s
  `memberships` field mask, but "returns a 400 error if `memberships` are being updated and there
  are no contact group memberships specified" — group membership management is finicky enough that
  Google also exposes a dedicated `contactGroups.members` modify endpoint outside `updateContact`
  proper for bulk add/remove.
- **photos is not writable via `updateContact`** — it's absent from the `updatePersonFields`
  writable set. Photo write-back is a **separate endpoint**,
  [`people.updateContactPhoto`](https://developers.google.com/people/api/rest/v1/people/updateContactPhoto):
  `PATCH …:updateContactPhoto`, request body `photoBytes` ("Raw photo bytes," base64-encoded),
  requiring the `https://www.googleapis.com/auth/contacts` scope. A companion
  `people.deleteContactPhoto` exists for removal. The reference page for this method does not
  publish an explicit byte-size ceiling (see §7).

### 1.5 Photo retrieval

Photos come back in the `photos[]` field as a `url`, not inline base64 — this differs from what
the ticket brief anticipated ("base64 default vs sizes query param"); the actual mechanism is a
plain HTTPS URL that already points at Google's photo CDN, resizable via the
[Image Sizing](https://developers.google.com/people/image-sizing) suffix convention (`=s`*n*,
`=w`*n*, `=h`*n*, `=c` for square crop, `=p` for a ~400px smart crop) rather than a `sz=` query
parameter. There is no documented default pixel size or maximum resolution on that reference page.
Retrieval is a plain unauthenticated-once-you-have-the-URL GET on the returned URL; write-back, per
§1.4, is the separate `updateContactPhoto` base64-body endpoint — read and write photos do not go
through the same shape at all.

### 1.6 Quotas

Source: [Read and Manage Contacts](https://developers.google.com/people/v1/contacts) (the
operational guide, not a dedicated numeric quota page — see §7 on why no fixed
requests-per-minute/day ceiling could be sourced).

The documented cost model is **quota units consumed per operation type**, not a single global
number:

- Create/update a single contact: "1 Critical read requests (Contact and Profile Reads), 1
  Critical write requests (Contact Creates and Updates), 1 Daily Contact Writes (Total)."
- Delete a single contact: "1 Write requests (Contact Deletes and Contact Group Writes)."
- Batch create/update (up to 200 contacts per call): "6 Critical read requests…6 Critical write
  requests…200 Daily Contact Writes (Total)" — batching is far cheaper per-contact than looping
  single creates.
- Batch delete: "10 Write requests (Contact Deletes and Contact Group Writes)."
- Operational guidance: "Mutate requests for the same user should be sent sequentially to avoid
  increased latency and failures" — Google explicitly discourages concurrent writes to the same
  user's contacts, which matters for how the Sync Backend should queue its pending-mutation
  overlay (ADR-0010) against a single Google account.

The actual per-project/per-user daily and per-minute ceilings against these quota-unit categories
are configured and shown live in the Google Cloud Console for the enabling project, not published
as a fixed number on a static docs page (Google's newer APIs generally manage this dynamically per
project rather than documenting one global figure) — see §7.

---

## 2. Microsoft Graph `contact` resource

Source: [`contact` resource type](https://learn.microsoft.com/en-us/graph/api/resources/contact)
(fetched via Microsoft Learn MCP).

### 2.1 Field coverage

The `contact` resource is a single flat object — no repeated/typed sub-collections for the things
Google and vCard model as repeatable-with-type:

| Property | Type | Note |
|---|---|---|
| `displayName`, `givenName`, `middleName`, `surname`, `nickName`, `initials`, `generation` (suffix), `title` (honorific), `yomiGivenName`/`yomiSurname`/`yomiCompanyName` | String | Flat name components, no repeatable structured name |
| `emailAddresses` | `emailAddress` collection: `{name, address}` only — **no `type`/label field at all** | Also `primaryEmailAddress`, `secondaryEmailAddress`, `tertiaryEmailAddress` — exactly three slots, not an arbitrary "primary flag on an array" |
| `businessPhones` (string collection), `homePhones` (string collection), `mobilePhone` (single string) | Three fixed phone-role buckets, not a typed repeatable list |
| `homeAddress`, `businessAddress`, `otherAddress` | `physicalAddress`: `{street, city, state, postalCode, countryOrRegion}` — **five flat fields, no PO box / extended-address / country-code split** | Exactly three named address slots; no arbitrary repeated+labeled addresses |
| `companyName`, `jobTitle`, `department`, `officeLocation`, `profession`, `manager` (string, just a name) | Flat, singular — **one company, one title, one department per contact**, no concurrent-organizations model |
| `birthday` | `DateTimeOffset`, "ISO 8601 format and is always in UTC" | No documented partial/year-optional form — a full calendar timestamp is expected |
| `photo` | `profilePhoto` navigation property, fetched/set via a **separate endpoint**, not inline on the contact payload | See §2.3 |
| `categories` | String collection | Free-form tag names into the mailbox-wide `outlookCategory` master list (§2.4) — not contact-specific |
| `spouseName`, `children` (string collection) | Flat relation fields — no general `relations[]`/typed-relationship model |
| `personalNotes` | String | Notes/biography equivalent |
| `imAddresses` | String collection | No protocol/type breakdown |
| `changeKey`, `id`, `createdDateTime`, `lastModifiedDateTime`, `parentFolderId` | Concurrency/bookkeeping | See §2.2 |

Contacts live inside `contactFolders`, which is itself a hierarchy — comparable in spirit to
Google's `contactGroups`, but a folder is a single-parent container a contact belongs to, not a
many-to-many label set the way both Google groups and vCard `CATEGORIES` are.

### 2.2 Concurrency: `changeKey` / `@odata.etag`

The `contact` resource carries `changeKey`: "Identifies the version of the contact. Every time the
contact is changed, ChangeKey changes as well. This allows Exchange to apply changes to the
correct version of the object." Notably, the
[Update contact](https://learn.microsoft.com/en-us/graph/api/contact-update) reference page's
request/response walkthrough shows a plain `PATCH /me/contacts/{id}` with a JSON body and **does
not document an `If-Match: {changeKey}` precondition header for contacts** the way, for example,
the [Update note](https://learn.microsoft.com/en-us/graph/api/note-update) API explicitly does
("Supports optimistic concurrency control via the `If-Match` header with the **changeKey** value
... We recommend that you use this header to avoid conflicts"). For contacts specifically, the
documented update semantics are last-write-wins by default: "Existing properties that aren't
included in the request body maintain their previous values." A Sync Backend cannot assume Graph
contact writes are etag-gated the way Google's are — this is a genuine asymmetry, not just a
documentation gap on our side (see §6).

### 2.3 Photo endpoint

The contact's photo is a `profilePhoto` relationship, not an inline field —
[`profilePhoto` resource](https://learn.microsoft.com/en-us/graph/api/resources/profilephoto):
"Represents a profile photo of a user, group, team, or Outlook contact... The data is binary and
not encoded in base-64." Read via `GET /me/contacts/{id}/photo/$value` (binary response, same
pattern as `GET /me/photo/$value` for the signed-in user shown in the
[Get profilePhoto](https://learn.microsoft.com/en-us/graph/api/profilephoto-get) examples, and a
sized variant exists too — `GET /me/photos/48x48/$value`). Write is `PATCH`/`PUT` to the same
binary endpoint via [Update profilePhoto](https://learn.microsoft.com/en-us/graph/api/profilephoto-update):
"Update the photo for the specified contact, group, team, or user in a tenant. **The size of the
photo you can update to is limited to 4 MB.**" `profilePhoto` itself only exposes `id`, `height`,
`width` as metadata — no format/URL field; the pixels are the binary response body.

### 2.4 Categories vs Google's contact groups

[`outlookCategory` resource type](https://learn.microsoft.com/en-us/graph/api/resources/outlookcategory):
"Represents a category by which a user can group Outlook items such as messages and events. The
user defines categories in a master list, and can apply one or more of these user-defined
categories to an item... Resources that can be assigned categories include **contact, event,
message, post, and todoTask**." Each category is `{displayName, color}`, "The `displayName` value
must be unique in a user's master list," and up to 25 distinct colors can be mapped across
categories. This is architecturally different from Google's `contactGroups`: Graph categories are
**one flat, mailbox-wide, cross-entity-type tag vocabulary** (the same "Follow up" category can
tag a contact, an email, and a calendar event) rather than a contacts-only hierarchical
many-to-many join.

### 2.5 Delta sync: `/me/contacts/delta` (or per-folder)

Source: [`contact: delta`](https://learn.microsoft.com/en-us/graph/api/contact-delta).

- Actual route is folder-scoped: `GET /me/contactFolders/{id}/contacts/delta` (there is no
  bare `/me/contacts/delta` in the reference — delta tracking is per contact folder).
- Permissions: `Contacts.Read` (delegated, work/school and personal Microsoft accounts) is the
  least-privileged read permission; `Contacts.ReadWrite` for write-back — both delegated and
  application variants exist.
- **Query-parameter freezing, same pattern as Google**: "If you use any query parameter (other
  than `$deltatoken` and `$skiptoken`), you must specify it in the initial delta request...
  Microsoft Graph automatically encodes any specified parameters into the token portion of the
  `@odata.nextLink` or `@odata.deltaLink` URL... In subsequent requests, simply copy and apply the
  ... URL from the previous response."
- **State tokens**: `@odata.nextLink` (carries a `$skiptoken`, meaning more pages remain in this
  round) vs. `@odata.deltaLink` (carries a `$deltatoken`, meaning this round is complete — save the
  whole URL and use it to start the next incremental round). Unlike Google, **no documented
  expiry window** was found for a Graph delta token on this reference page (Google's is explicit
  at 7 days; Graph's contact-delta page states the token mechanics but not a validity duration —
  see §7).
- `$select` is supported to narrow returned properties; `id` is always returned regardless.
- `Prefer: odata.maxpagesize={x}` header controls page size (shown with `maxpagesize=2` in the
  worked example).

### 2.6 Permissions

Source: [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) (via docs search).

| Scope | Type | Description (verbatim) |
|---|---|---|
| `Contacts.Read` | Delegated (work/school, personal MSA) & Application | "Allows the app to read user contacts." / Application: "Allows the app to read all contacts in all mailboxes without a signed-in user." Available for consent on personal Microsoft accounts. |
| `Contacts.Read.Shared` | Delegated only | "Allows the app to read contacts a user has permissions to access, including their own and shared contacts." |
| `Contacts.ReadWrite` | Delegated & Application | "Allows the app to create, read, update, and delete user contacts." / Application: "...all contacts in all mailboxes without a signed-in user." Also available on personal Microsoft accounts. |
| `Contacts.ReadWrite.Shared` | Delegated only | "Allows the app to create, read, update, and delete contacts a user has permissions to, including their own and shared contacts." |

`List contacts`, `Get contact`, and `contact: delta` all name `Contacts.Read` as their
least-privileged permission and `Contacts.ReadWrite` as the higher-privileged one, consistently.

---

## 3. RFC 6350 (vCard 4.0)

Source: the RFC text itself, [rfc-editor.org/rfc/rfc6350.txt](https://www.rfc-editor.org/rfc/rfc6350.txt).

> "This document defines the vCard data format for representing and exchanging a variety of
> information about individuals and other entities (e.g., formatted and structured name and
> delivery addresses, email address, multiple telephone numbers, photograph, logo, audio clips,
> etc.)."

### 3.1 Grouping mechanism (§3.3)

> "The group construct is used to group related properties together. The group name is a
> syntactic convention used to indicate that all property names prefaced with the same group name
> SHOULD be grouped together when displayed by an application."

ABNF: `contentline = [group "."] name *(";" param) ":" value CRLF`. Implementations that don't
understand grouping "MAY simply strip off any text before a '.'" — the mechanism is advisory
presentation grouping (e.g. tying an `ADR` and a `TEL` together as "this is the office"), not a
structural container the way Google's `contactGroups` or Graph's `contactFolders` are.

### 3.2 Core property definitions

- **FN** (§6.2.1) — "To specify the formatted text corresponding to the name of the object the
  vCard represents." Cardinality `1*` — **required**, at least one instance, single text value.
- **N** (§6.2.2) — "To specify the components of the name of the object the vCard represents,"
  cardinality `*1` (optional, at most one). "The structured property value corresponds, in
  sequence, to the Family Names..., Given Names, Additional Names, Honorific Prefixes, and
  Honorific Suffixes." Each of the five components can itself hold multiple comma-separated
  values via `list-component = component *("," component)` — the RFC's own example:
  `N:Stevenson;John;Philip,Paul;Dr.;Jr.,M.D.,A.C.P.` (two middle names, two suffixes).
- **EMAIL** (§6.4.2) — "To specify the electronic mail address for communication with the object
  the vCard represents," cardinality `*` (repeatable), `PREF` parameter marks a preferred address
  among several.
- **TEL** (§6.4.1) — free-form text or URI value; predefined `TYPE` values include `text, voice,
  fax, cell, video, pager, textphone`; "The default type is 'voice.'"
- **ADR** (§6.3.1) — structured, semicolon-separated, cardinality `*`: "the post office box; the
  extended address (e.g., apartment or suite number); the street address; the locality (e.g.,
  city); the region (e.g., state or province); the postal code; the country name" — **7 components
  in a fixed order**, ABNF `ADR-value = pobox ";" ext ";" street ";" locality ";" region ";" code
  ";" country`.
- **ORG** (§6.6.4) — "the organizational name and units associated with the vCard," structured,
  semicolon-separated: "organization name, followed by zero or more levels of organizational unit
  names" (`ORG-value = component *(";" component)`). Cardinality `*` — **`ORG` is repeatable as a
  property**, so multiple `ORG` lines can appear on one vCard, but there is no native "this is my
  current job vs. a past one" flag or per-org title pairing the way Google's `organizations[]`
  carries `current`/`startDate`/`endDate` alongside each org — a repeated `ORG` plus a repeated
  `TITLE` is two parallel unlinked lists, not paired records.
- **TITLE** (§6.6.1) — "the position or job of the object the vCard represents," based on the
  X.520 Title attribute, single text value, cardinality `*`.
- **BDAY** (§6.2.5) — "To specify the birth date of the object the vCard represents." Value type
  `date-and-or-time` (default) or plain text, cardinality `*1`. Explicitly supports **reduced
  accuracy / truncated ISO 8601 forms omitting the year** — the ticket's cited `--MMDD` form is
  exactly this: `date = year [month day] / year "-" month / "--" month [day] / "--" "-" day`,
  giving forms like `--0415` (month-day, no year) and `---12` (day only). This is the one property
  in the whole comparison where vCard's model is strictly *more* expressive than Graph's
  (full-`DateTimeOffset`-only) and matches Google's (year-optional `Date` message) capability.
- **PHOTO** (§6.2.4) — "an image or photograph... that annotates some aspect of the object the
  vCard represents," value type single URI, cardinality `*`. Critically, the URI **can be a `data:`
  URI carrying base64-encoded bytes inline** — the RFC's own example:
  `PHOTO:data:image/jpeg;base64,MIICajCCAdOgAwIBAgICBEUwDQYJKoZIhv...` — so vCard natively supports
  both a remote-URL photo reference *and* a fully self-contained inline photo in the same property
  grammar, unlike Google (URL only, read side) and Graph (separate binary endpoint only).
- **CATEGORIES** (§6.7.1) — "application category information about the vCard, also known as
  'tags,'" a flat comma-separated text list, cardinality `*`. No hierarchy, no per-category color
  or shared cross-entity vocabulary — closest in shape to Graph's `categories` collection, but
  without Graph's mailbox-wide shared master list (each vCard's `CATEGORIES` is self-contained
  free text, no dictionary to reconcile against).
- **UID** (§6.7.6) — "a value that represents a globally unique identifier corresponding to the
  entity associated with the vCard," URI or free text, cardinality `*1`. "The 'uuid' URN namespace
  defined in [RFC4122] is particularly well suited to this task, but other URI schemes MAY be
  used."
- **REV** (§6.7.4) — "revision information about the current vCard," a single timestamp,
  cardinality `*1` — a last-modified marker, not an optimistic-concurrency token (no
  compare-and-swap semantics are defined for it; it's informational).
- **RELATED** (§6.6.6) — "a relationship between another entity and the entity represented by this
  vCard," URI or text value, cardinality `*`. `TYPE` values: `contact, acquaintance, friend, met,
  co-worker, colleague, co-resident, neighbor, child, parent, sibling, spouse, kin, muse, crush,
  date, sweetheart, me, agent, emergency` — a much richer vocabulary than Google's `relations[]`
  types or Graph's two named fields (`manager`, `spouseName`), and (like `MEMBER`) can point at
  another vCard's `UID` via a `urn:uuid:` URI rather than only holding a free-text name.
- **MEMBER** (§6.6.5) — "To include a member in the group this vCard represents." "This property
  MUST NOT be present unless the value of the `KIND` property is 'group.'" Worked example:
  ```
  BEGIN:VCARD
  VERSION:4.0
  KIND:group
  FN:The Doe family
  MEMBER:urn:uuid:03a0e51f-d1aa-4385-8a53-e29025acd8af
  MEMBER:urn:uuid:b8767877-b4a1-4c70-9acc-505d3819e519
  END:VCARD
  ```
- **KIND** (§6.1.4) — "the kind of object the vCard represents": `individual` (default if
  absent), `group` ("The group's member entities can be other vCards or other types of entities,
  such as email addresses or web sites"), `org`, `location`, plus `iana-token`/`x-name` extension
  points. **This is vCard's mechanism for representing what Google calls a contact group /
  label as its own first-class addressable entity** — a `KIND:group` vCard with `MEMBER` lines,
  rather than a join-table membership field on each individual contact.
- **TYPE parameter** (§5.6) applies uniformly across many properties (`FN, NICKNAME, PHOTO, ADR,
  TEL, EMAIL, IMPP, LANG, TZ, GEO, TITLE, ROLE, LOGO, ORG, RELATED, CATEGORIES, NOTE, SOUND, URL,
  KEY, FBURL, CALADRURI, CALURI`) — "work" and "home" act like tags rather than a fixed enum, and
  a value can carry more than one TYPE at once.
- **Extensibility**: `iana-token` (registered) and `x-name` (`x-`/`X-`-prefixed experimental)
  cover custom properties and parameters — the vCard equivalent of Google's `userDefined[]`/
  `clientData[]` or a hypothetical Graph open extension.

---

## 4. Cross-mapping table

| Field family | Google People API | Microsoft Graph `contact` | vCard 4 (RFC 6350) | Reconciles cleanly? | Notes on loss |
|---|---|---|---|---|---|
| **Name** | `names[]`: structured `given/family/middle/honorificPrefix/honorificSuffix` + phonetic variants; repeatable but effectively one canonical entry | Flat top-level `givenName`/`middleName`/`surname`/`initials`/`generation`(suffix)/`title`(honorific) + separate `displayName`; exactly one set, no repetition | `N` (structured, 5 components, each multi-valued via comma) + required `FN` (single formatted string) | **Mostly** | Google's phonetic name fields (`phoneticGivenName` etc.) have no Graph or vCard equivalent; Graph's `yomi*` phonetic fields are the mirror-image gap (vCard/Google have no phonetic-*company*-name slot). `FN` must be synthesized/duplicated from `N` for vCard, and Graph's `displayName` gets silently regenerated by the server on other-field updates ("later updates to other properties may cause an automatically generated value to overwrite the displayName value") — a foreign-system round trip can lose a manually-set display name. |
| **Emails (multi, typed, primary)** | `emailAddresses[]`: `value/type/formattedType` + `metadata.primary` flag | `emailAddresses[]` = `{name, address}` **only**, no type/label at all; plus fixed `primaryEmailAddress`/`secondaryEmailAddress`/`tertiaryEmailAddress` slots | `EMAIL`, repeatable, `TYPE` param (home/work/etc.), `PREF` param for preference ranking | **No** | Graph has no per-address type (home/work/other) at all — a Google/vCard "work" label has nowhere to land on Graph except possibly `categories` (mailbox-wide, wrong granularity) or being dropped. Graph's primary/secondary/tertiary is an *ordinal rank of at most 3*, not a boolean-primary-among-N — a 4th address or a re-ranking doesn't map onto Google's single-`primary`-flag model cleanly either. |
| **Phones (multi, typed)** | `phoneNumbers[]`: `value/type/formattedType/canonicalForm` (E.164), open type vocabulary | Three fixed buckets: `businessPhones[]` (collection), `homePhones[]` (collection), `mobilePhone` (single scalar) — no `type` field, the *property name itself* is the type | `TEL`, repeatable, `TYPE` param (`voice, fax, cell, video, pager, textphone`, home/work via TYPE too) | **Partially** | Google/vCard's rich type vocabulary (`googleVoice`, `workMobile`, `main`, `pager`, fax variants) has no Graph equivalent beyond home/business/mobile — a `workFax` or `main` number must be forced into `businessPhones[]` losing its distinct type, or dropped. Graph's `mobilePhone` is a single scalar — a second mobile number from Google/vCard has nowhere to go without overwriting. |
| **Addresses** | `addresses[]`: `poBox/streetAddress/extendedAddress/city/region/postalCode/country/countryCode/formattedValue`, arbitrary count, typed/labeled | Exactly three named slots: `homeAddress`/`businessAddress`/`otherAddress`, each a flat `{street,city,state,postalCode,countryOrRegion}` — **no PO box, no extended/apartment line, no ISO country code** | `ADR`, repeatable, 7 fixed structured components (pobox;ext;street;locality;region;code;country), `TYPE` param | **No** | Graph caps addresses at 3 (home/business/other) — a 4th address (e.g. two "other" addresses) is unrepresentable without merging or dropping one. Graph's `physicalAddress` has no PO-box or apartment/suite (`extendedAddress`) field at all — that data must be folded into `street` as free text, losing structure. Country is free text on Graph (`countryOrRegion`) vs. Google's separate machine-readable `countryCode` — round-tripping through Graph loses the ISO code. |
| **Organization(s)** | `organizations[]`: multiple entries, each with `name/department/title/current/startDate/endDate` — **concurrent current orgs are native** | Flat singular `companyName`/`jobTitle`/`department`/`officeLocation` — **one org, one title, at most, ever** | `ORG` repeatable (org + unit levels) and `TITLE` repeatable, but as **two independent parallel property lists** — no structural pairing of "this title belongs to this org," and no `current`/date-range concept at all | **No** | A person with two current jobs (Google models this natively) collapses to one on Graph — a real loss, not just relabeling. Going Google → vCard, `ORG`/`TITLE` pairs must be reconstructed positionally (assume list index *i* of `ORG` pairs with index *i* of `TITLE`) since the RFC defines no such pairing — ambiguous once counts diverge. Neither Graph nor vCard has `startDate`/`endDate`/`current` for organization history — historical (non-current) organizations from Google have no home in either. |
| **Birthday** | `birthdays[].date`: `year` optional (year-omitted supported natively) | `birthday`: `DateTimeOffset`, "always in UTC" — **no documented partial-date / year-omitted form**, expects a full timestamp | `BDAY`: explicit truncated ISO 8601 forms, `--MMDD` (no year), `---DD` (day only) | **No** | This is the single cleanest three-way mismatch: Google and vCard both support "no year," Graph does not. A yearless Google/vCard birthday synced to Graph must either be dropped, stored with a sentinel/placeholder year (itself a lossy lie the model must flag), or kept out of Graph write-back entirely. |
| **Photo** | `photos[]`: read-only `url` (sizeable via `=s`/`=w`/`=h` suffixes, no documented max); write via **separate** `updateContactPhoto` (base64 `photoBytes`, no documented size cap found) | `photo` navigation property, **binary-only** `$value` endpoint for both read and write; write capped at **4 MB** (documented) | `PHOTO`: single URI, which **may be a `data:` URI with inline base64** — the only one of the three that can hold a photo *and* a reference in the same property shape | **Partially** | Read and write shapes differ *within* Google itself (URL out, base64 in) and *within* Graph itself (binary out, binary in but via a wholly separate endpoint from the contact payload) — a model has to treat "photo" as an out-of-band blob reference for all three systems, never an inline JSON field, except when literally exporting/importing vCard files where inlining is idiomatic. Graph's 4 MB cap is the tightest of the three and the only one with a documented number; a photo within Google's or vCard's practical range could still be rejected on write to Graph. |
| **Groups / Labels / Categories** | `memberships[].contactGroupMembership`: many-to-many join to `contactGroups`, **contacts-only**, hierarchical (system groups like `myContacts`/`starred` plus user groups); partial write-restrictions (some system groups membership-add-only via specific endpoints) | `categories[]`: flat tag names into one **mailbox-wide `outlookCategory` master list shared across contacts, events, messages, tasks** — same category name means the same thing everywhere in the mailbox | `CATEGORIES`: flat, per-vCard free-text tag list, no shared dictionary; alternatively `KIND:group` + `MEMBER` vCards represent a group as its **own separate top-level vCard** entity | **No** | Three structurally different mechanisms: a contacts-scoped many-to-many join (Google) vs. a mailbox-wide flat tag vocabulary shared with non-contact item types (Graph) vs. either free per-vCard text or a wholly separate group-as-vCard entity (RFC). A Google contact group synced to Graph becomes a `categories` tag — but that tag's *name* is now globally visible/reusable across the whole mailbox (an email or event could pick up "Family" too), a scope change the source system never had. A vCard's `CATEGORIES` has no cross-vCard identity at all — two vCards both saying `CATEGORIES:Family` are not provably "the same group" the way a Google `contactGroupResourceName` or a shared Graph category name are. |
| **Notes / biography** | `biographies[]` (`TEXT_PLAIN`/`TEXT_HTML`), singleton in practice | `personalNotes`: plain string | `NOTE` property (not detailed above but present in RFC 6350 §6.7.2 as free text) | **Yes** | All three reduce to "one blob of text per contact" — one of the few clean, lossless three-way matches (modulo Google's HTML-vs-plain content-type distinction, which Graph/vCard don't carry separately). |
| **Nicknames** | `nicknames[]`, typed (`DEFAULT/MAIDEN_NAME/INITIALS/GPLUS/OTHER_NAME/ALTERNATE_NAME/SHORT_NAME`), repeatable | `nickName`: single flat string | `NICKNAME` property, repeatable, `TYPE` param supported (per §5.6's applicability list) | **Partially** | Graph allows exactly one nickname; Google/vCard allow several with semantic sub-types (maiden name vs. short name) that collapse to an undifferentiated single string on Graph, and the *type* distinction itself has no home on Graph even for one nickname. |
| **Websites / URLs** | `urls[]`: `value/type` (home, work, blog, profile, homePage, ftp, …) | No dedicated field — closest is `businessHomePage` (single string) | `URL` property, repeatable, `TYPE` param | **No** | Graph effectively supports one URL (the business home page); any personal site, blog, or social profile URL from Google/vCard has no Graph field to land in short of an open extension (custom property), which isn't part of the standard schema this table compares. |
| **IM / social handles** | `imClients[]`: `username/protocol/type` (aim, msn, yahoo, skype, qq, googleTalk, icq, jabber, netMeeting) | `imAddresses[]`: flat string collection, **no protocol or type field** | `IMPP` property (not detailed above but present in RFC 6350 §6.4.3), URI-typed (e.g. `xmpp:user@example.com`), `TYPE` param | **Partially** | The protocol tag is the casualty: Google's `protocol` enum and vCard's URI scheme both encode "this is Jabber vs. Skype," while Graph's flat string list holds addresses with no protocol marker — round-tripping through Graph either loses the protocol or requires guessing it back out of the address string. |
| **Relations** | `relations[]`: free-text `person` name + `type` enum (spouse, child, mother, father, manager, assistant, referredBy, partner, …) | Only two named fields exist: `spouseName` (string) and `children[]` (string collection) — no `manager`-as-relation field on `contact` itself (there's a *separate* `manager` string field, but it's not part of a general relations model), no general relation-type vocabulary | `RELATED`: repeatable, rich `TYPE` vocabulary (`spouse, child, parent, sibling, manager` is *not* in vCard's list — vCard's is oriented around personal/social relations: `contact, acquaintance, friend, met, co-worker, colleague, co-resident, neighbor, child, parent, sibling, spouse, kin, muse, crush, date, sweetheart, me, agent, emergency`), and the value can be a `urn:uuid:` reference to another vCard's `UID` | **No** | Three incompatible vocabularies with only partial overlap (spouse and child appear in all three by name; Google's `manager`/`assistant`/`referredBy` have no vCard equivalent; vCard's `crush`/`date`/`sweetheart`/`emergency`/`agent` have no Google or Graph equivalent at all). Graphs' fixed two fields can only ever hold a spouse and children — every other relation type Google or vCard might carry is simply unrepresentable on Graph. |
| **UID / identifier stability & concurrency token** | `resourceName` (`people/{id}`, stable identifier) + `etag` (whole-resource optimistic-concurrency token, required on write per §1.4) | `id` (**not guaranteed stable** — "By default, this value changes when the item is moved from one container... to another," fixable only by requesting `Prefer: IdType=\"ImmutableId\"`) + `changeKey` (version marker, but — per §2.2 — not documented as enforced via an `If-Match` precondition on contact writes) | `UID` (RFC recommends a `urn:uuid:` per RFC 4122, but declares no enforcement — nothing stops two vCards claiming the same UID) + `REV` (a bare last-modified timestamp, not a compare-and-swap token at all) | **No** | Every system's identifier/concurrency story is different in kind: Google is the only one of the three with an *enforced* optimistic-concurrency precondition on write (etag mismatch → `400 failedPrecondition`); Graph's `changeKey` exists but isn't documented as gating contact writes; vCard's `UID` is a convention with zero server-side enforcement, and `REV` is purely informational. A shared Contact model that wants "safe concurrent edit" for all three has to invent its own conflict-resolution layer for Graph and vCard rather than delegate to the upstream's own token — which is exactly what ADR-0010's mirror-with-upstream-wins design already does for Google's case, and must do unconditionally (no upstream signal to lean on) for Graph and vCard. |
| **Custom / user-defined fields** | `userDefined[]` (arbitrary user key/value, freeform) + `clientData[]` (arbitrary client key/value, duplicates allowed) | Open extensions / single- and multi-value extended properties (separate relationships, not part of the base `contact` JSON shown in §2.1) | `iana-token`/`x-name` custom properties (`X-`-prefixed lines) | **Partially** | All three have *an* extensibility mechanism, but they're structurally unrelated (typed key/value array vs. a separate Graph extension object fetched via `$expand` vs. arbitrary custom property lines in the vCard text) — round-tripping a custom field through all three requires the model to pick one canonical shape (most likely Google's flat key/value, since it's the simplest) and translate, which is lossy for anything Graph's richer open-extension objects can carry (nested JSON) that a flat key/value string cannot. |

---

## 5. What the Contact model must drop or approximate

This is the standalone answer to the ticket's central ask — "the Contact model has to state what
it drops." In priority order, most consequential first:

1. **Concurrent multiple current organizations (Google → Graph, unrecoverable).** Google's
   `organizations[]` natively allows several `current: true` entries (e.g. a person who is both a
   consultant at Firm A and a board member at Firm B right now). Graph has exactly one
   `companyName`/`jobTitle`/`department`. **The model must pick one organization to be "the"
   Graph-facing org (e.g. the one marked primary, or the most recently started) and silently drop
   the rest on any Google→Graph-shaped view or write-back.** This is a real, unrecoverable loss of
   information, not a relabeling.

2. **Birthday year (Google/vCard → Graph, unrecoverable on write to Graph).** Both Google
   (`birthdays[].date` with optional `year`) and vCard (`BDAY` `--MMDD` form) can express "I know
   the month and day, not the year" — this is extremely common (many people share month/day
   publicly but not birth year). Graph's `birthday` is a full `DateTimeOffset` with no documented
   year-optional form. **The model must either (a) refuse to write a yearless birthday to Graph at
   all, or (b) invent a sentinel year (e.g. 1604, the common "no year" convention used by some
   calendar apps) and flag it internally as synthetic — never present a Graph-sourced sentinel year
   back to the user as if it were real.** Losing the "no year" *fact itself* on a naive round-trip
   is the failure mode to design against.

3. **Address field richness (Google/vCard → Graph, lossy on write; Graph → Google/vCard, no loss
   but no upside either).** Graph's `physicalAddress` has no PO box and no extended/apartment line
   — those must be folded into `street` as unstructured text when writing to Graph, and Graph
   caps you at exactly 3 addresses (home/business/other) where Google/vCard allow arbitrarily
   many. **A 4th+ address, or any PO-box/suite-line data, cannot round-trip through a Graph write
   without lossy string-folding or being dropped outright.**

4. **Email/phone "type" vanishes through Graph for email (unrecoverable); phone types narrow to
   three buckets.** Graph's `emailAddresses[]` has no type field at all — "work" vs. "personal"
   email labeling from Google or vCard has nowhere to go on Graph. Phone numbers fare slightly
   better (home/business/mobile buckets exist) but Google/vCard's richer vocabulary (`googleVoice`,
   `main`, `pager`, `workFax`, `otherFax`, arbitrary custom types) has no Graph equivalent beyond
   those three buckets. **The model must decide, per field family, whether an unmappable type is
   dropped silently or preserved as a private extension only visible when not round-tripping
   through Graph** — either way, that decision needs to be explicit and documented per family, not
   implicit.

5. **Groups/Labels/Categories are three incompatible scoping models.** Google's contact groups are
   a contacts-only many-to-many join; Graph's categories are a flat tag vocabulary **shared across
   contacts, events, messages, and tasks in the whole mailbox**; vCard's `CATEGORIES` is
   per-vCard free text with no shared identity across vCards at all (two vCards saying
   `CATEGORIES:Family` have no provable relationship), while vCard's alternate `KIND:group` +
   `MEMBER` mechanism represents a group as an entirely separate top-level entity rather than a
   membership flag on each contact. **A Google contact group synced into a Contact model and then
   projected onto Graph as a category changes its blast radius — that same category name is now
   available (and meaningful) on the user's emails and calendar events too, a scope widening the
   source system never had.** The model must decide whether that scope leak is acceptable, namespaced
   away (e.g. prefixing Contacts-originated categories), or simply not synced to Graph at all.

6. **Relation-type vocabularies barely overlap.** Google's `relations[]` enum, Graph's two fixed
   fields (`spouseName`, `children[]` — nothing more), and vCard's `RELATED` `TYPE` vocabulary
   (oriented toward personal/social relations, no `manager`/`assistant`) share almost nothing.
   **Only "spouse" and "child" survive a three-way round-trip intact; every other relation type
   (manager, assistant, referredBy, colleague, muse, emergency, …) is representable in at most one
   or two of the three systems and must be dropped when writing to the systems that lack it.**

7. **No shared, enforced identifier or concurrency token across all three.** Google's `etag` is the
   only *enforced* optimistic-concurrency precondition among the three (a stale etag write is
   rejected with `400 failedPrecondition`). Graph's `changeKey` exists as a version marker but
   isn't documented as gating contact PATCH requests via `If-Match` the way some other Graph
   resources (e.g. `note`) explicitly are. vCard's `UID` is a convention with no server enforcing
   uniqueness, and `REV` is purely informational, not a compare-and-swap token. **The Contact
   model cannot delegate conflict detection to the upstream uniformly — it must always run its own
   mirror-with-upstream-wins conflict resolution (ADR-0010) rather than assume every upstream will
   reject a stale write on its own.** This validates the map's chosen architecture rather than
   surfacing a gap in it, but it means the *Contact* model specifically cannot special-case
   "trust Graph's changeKey the way we trust Google's etag" — the safety net has to be uniform
   across origins.

8. **Photo is never an inline field for API-sourced contacts, only for vCard files.** Google reads
   photos as a URL and writes them as base64 through a wholly separate endpoint from the contact's
   other fields; Graph reads and writes photos as raw binary through a wholly separate endpoint;
   only vCard's `PHOTO` property can hold either a URL *or* inline base64 in the same field. **The
   model's internal representation of "photo" must be an out-of-band blob reference (fetch-on-demand
   or cached-and-hashed) for every API origin, and only becomes an inline `data:`-URI value at the
   moment of vCard export/import** — treating it as a plain string field on the Contact record
   itself would misrepresent every non-vCard origin.

9. **Sync-token/delta-token expiry and validity windows differ, and one is undocumented.** Google's
   sync token has a documented, hard 7-day validity window with a named error
   (`EXPIRED_SYNC_TOKEN`) and explicit fallback guidance (full resync). Graph's delta token
   mechanics were fully documented on the `contact: delta` reference page, but **no expiry window
   for that token could be found on the fetched pages** (see §7) — the Sync Backend cannot assume
   parity here and should build the same "periodic forced full resync" discipline for Graph
   defensively, even without a documented number to justify a specific interval, rather than
   assuming Graph's delta token is valid indefinitely.

10. **Websites/URLs and IM protocol tags thin out on Graph.** Graph has no general "URL" field
    (only a single `businessHomePage`) and no protocol marker on `imAddresses`. Any personal
    website, social profile link, or IM protocol distinction from Google or vCard has no proper
    home on Graph's base schema — landing it in `categories` or a note field would be a category
    error, so the honest answer is these are dropped on write to Graph, full stop, absent a custom
    Graph open extension (out of scope for the base `contact` schema compared here).

---

## 6. Summary of what's needed for the Sync Backend (non-normative, ties back to the ticket)

- **Scope**: `https://www.googleapis.com/auth/contacts` (read-write) is required once write-back
  exists; `contacts.readonly` alone is insufficient. `contacts.other.readonly` is a distinct grant
  worth deferring until/unless "Correspondents" ever needs Google's own auto-collected contacts
  rather than deriving purely from local mail history.
- **Sync loop**: full `connections.list` walk with `requestSyncToken=true` and a fixed
  `personFields` mask to mint a token; store the token; poll with `syncToken` (same field mask);
  on `EXPIRED_SYNC_TOKEN`, drop the token and re-run a full sync; force a full resync at least every
  7 days regardless, since that's the documented token lifetime.
- **Write-back**: fetch-etag → PATCH-with-etag → chain the returned etag into the next write,
  matching ADR-0010's overlay-then-reconcile shape; photo write-back is a categorically separate
  call (`updateContactPhoto`), not part of the normal field-level PATCH.
- **Quotas**: no fixed global number to build headroom math against (see §7) — but the documented
  unit-cost model rewards batching (batch create/update of 200 contacts costs the same *critical*
  read/write units as roughly 6 single calls) and explicitly discourages concurrent writes to the
  same user, which should shape the pending-mutation overlay's write queue to be per-account
  sequential, not fanned out.

---

## 7. Source-access notes

- **Google OAuth scopes, generic page**: the general
  [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes)
  reference page did not render a "People API" section through repeated fetches (the page appears
  to truncate/paginate client-side in a way the fetch tool couldn't reach). The exact scope
  strings and descriptions used throughout this document instead come from the People API's own
  [OAuth2 discovery document](https://people.googleapis.com/$discovery/rest?version=v1)
  (`people.googleapis.com/$discovery/rest?version=v1`), which is Google's own machine-readable,
  authoritative source for exactly this API's scopes and is arguably a *stronger* primary source
  than the human-readable cross-API table.
- **Google People API quota ceilings**: no page could be found publishing a fixed
  requests-per-minute/day number for `people.googleapis.com` (repeated targeted searches and
  fetches of likely URL patterns — `/people/v1/limits`, various guessed quota-page paths — 404'd
  or surfaced no such page). The only documented quota information found is the **per-operation
  quota-unit cost model** on the [Read and Manage Contacts](https://developers.google.com/people/v1/contacts)
  page, quoted in full in §1.6. The actual per-project ceiling against those units is almost
  certainly configured/visible only in the Google Cloud Console for an enabled project (consistent
  with how Google now manages quotas for many newer APIs), not published as a static number — if
  an exact ceiling is needed before implementation, it should be pulled from the Cloud Console for
  the project that will host the Sync Backend's Google integration, not from public docs.
- **Google People API photo size limits**: neither the
  [Image Sizing](https://developers.google.com/people/image-sizing) page (read side) nor the
  [`updateContactPhoto`](https://developers.google.com/people/api/rest/v1/people/updateContactPhoto)
  reference (write side) documents an explicit maximum photo byte size or pixel dimension. Graph's
  4 MB write cap (§2.3) is the only hard, documented number among the three systems for photo size
  — worth treating as the practical ceiling to design around even for Google/vCard photos, absent
  a published Google number.
- **Google sync token expiry, exact HTTP status code**: the `connections.list` reference page
  documents the *semantic* error (`google.rpc.ErrorInfo` with reason `EXPIRED_SYNC_TOKEN`) but the
  fetched content did not surface an explicit numeric HTTP status paired with it. This document
  does not guess a status code (400 vs. 410) that isn't directly quoted from the source — treat the
  reason string, not an assumed status code, as the reliable signal to branch on.
- **Microsoft Graph delta-token expiry**: the [`contact: delta`](https://learn.microsoft.com/en-us/graph/api/contact-delta)
  reference page documents the `$deltatoken`/`$skiptoken` mechanics in full but states no validity
  window (contrast Google's explicit "7 days"). This may exist on a general
  [delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview) page not
  fetched in this pass — worth a follow-up fetch before finalizing the Sync Backend's Graph resync
  cadence, but absent that, this document does not assert a number.
- **Microsoft Graph contact `@odata.etag` / `If-Match` on write**: the
  [Update contact](https://learn.microsoft.com/en-us/graph/api/contact-update) reference page's
  request-headers table lists only `Authorization` and `Content-Type` — no `If-Match` row — unlike
  the [Update note](https://learn.microsoft.com/en-us/graph/api/note-update) page, which
  explicitly documents `If-Match` with `changeKey` for optimistic concurrency. This is reported
  as-observed (§2.2, §5 point 7) rather than as confirmation that Graph contacts categorically
  cannot use `If-Match` — Graph resources generally support `@odata.etag`/`If-Match` as a
  cross-cutting OData convention, so it is possible the contact-update page simply omits it from
  its worked example rather than the capability not existing. Flagged here so implementation-time
  research re-checks this specifically (e.g. by inspecting a live `GET` response for a
  `@odata.etag` header on a contact) before assuming last-write-wins is the only option for Graph.
- **RFC 6350 vCard `NOTE`/`IMPP` properties**: referenced in §4's table (Notes/biography, IM
  handles rows) by RFC section number and general shape from the RFC's structural conventions, but
  not independently quoted from the RFC text with the same verbatim-fetch rigor as the properties
  in §3.2 — a follow-up fetch targeting RFC 6350 §6.4.3 (`IMPP`) and §6.7.2 (`NOTE`) directly would
  firm up their exact ABNF/cardinality before this table is treated as final for implementation.
