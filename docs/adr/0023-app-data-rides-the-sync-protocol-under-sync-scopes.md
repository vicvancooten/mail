# App data rides the sync protocol under Sync Scopes; small App collections replicate whole

The Hub Apps ([#158](https://github.com/vicvancooten/mail/issues/158)) bring Notes, Contacts, Events
and Tasks to a Client whose protocol and cache were designed for mail. Rather than a second endpoint
or a second cache posture per App, every App collection rides the one `POST /sync` of
[ADR-0011](0011-one-delta-endpoint-with-per-collection-state-tokens.md) and declares a **Sync
Scope**: User, Mail Account or Connected Account. Small collections (Notes, Contacts, Labels) are
**replicated whole** into the Local Cache instead of windowed like Threads; Events get one
time-range window. Decided in the #166 grilling, 2026-09-07.

## Considered Options

- **A separate endpoint or protocol for App data**: rejected. Native Clients will speak the sync
  protocol; two protocols is two things to keep in step for no gain, and the App collections are the
  same shape (list-row projections, state tokens, tombstones) as the mail ones.
- **Bolting Connected Account onto the Mail Account slot** of the request: rejected. It hides which
  kind of thing a collection hangs off, and ADR-0022 made the Mail Account a Facet of the Connected
  Account, so the two are not interchangeable.
- **Restructuring the wire to `scopes: [{kind, id, collections}]`** under a new protocol version:
  rejected. ADR-0011's additive-only rule holds: `user` and `mailAccounts` stay, and a
  `connectedAccounts` sibling appears when the first Connected-Account-scoped collection does.
- **Windowing every App collection the way Threads are windowed**: rejected. Notes and Contacts are
  hundreds to low thousands of rows and are browsed alphabetically or by any filter, which a
  newest-first window with one hole at the bottom serves badly. A full replica of a small collection
  is the cheaper posture and makes offline browsing and client-side filtering exact.
- **Replicating Events whole too**: rejected. A fifteen-year upstream calendar is not small; Events
  get one rolling past-and-future window, the one list-window shape ADR-0009 did not have.
- **Every Note edit as an Optimistic Action intent** (`updateNote(fullDocument)`): rejected. Body
  edits are last-write-wins per Note, which is the shape compose saves already have; intents are
  strict FIFO with idempotency, which structural actions need and edits do not.

## Consequences

- **Each collection declares its Sync Scope**, and a **collection registry** on both sides replaces
  the hand-written per-collection wiring before the first App collection lands: the Sync Backend
  registers `{name, scopeKind, query, project}`, the Client registers `{name, table, tokenKey,
  apply}`. Four Apps add roughly eight collections, and each should be a declaration, not six edits
  in six files.
- **Notes and Tasks are User-scoped**, like Preference. Contacts and Events take the Sync Scope of
  their Origin's owner per [ADR-0022](0022-connected-account-owns-the-credential.md), fixed in their
  own tickets.
- **Label moves to User scope.** A User gets one set of Labels spanning all their Mail Accounts and
  their Notes; same-named Labels across a User's Mail Accounts merge on migration. This is the one
  change here that touches existing mail data and is its own slice, ordered before Notes.
- **The Local Cache's glossary entry widens**: it holds a bounded slice of mail and the whole of the
  User's small App collections. It stays disposable and rebuildable; a full replica of a small
  collection is still a cache, not a source of truth.
- **Note bodies travel on a `noteSaves` channel** modelled on compose saves: one queued save per
  Note, whole document, a newer save replacing a queued older one, the server taking the latest by
  receipt and never rejecting a Note write. Two devices editing one Note offline is resolved by
  last write wins; a merge (CRDT) waits for multiplayer, which is out of scope. Structural actions
  (pin, delete, restore, label) are ordinary intents on the User-scoped Optimistic Action queue,
  with real inverses per [ADR-0019](0019-undo-is-an-inverse-action-not-a-queue-cancellation.md).
- **A Note's id is a client-generated ULID**, so a Note created offline has its address at once and
  the server accepts the id as given, as Compositions already do.
- **App collections emit Sync Hints** through the same `LISTEN/NOTIFY` path
  ([ADR-0015](0015-realtime-is-sse-hints-plus-web-push.md)); the hint payload stays empty. Nothing
  App-related goes over Web Push except what the Notifier later decides for Calendar reminders.
- **An App declares whether it observes Account Scope.** Notes and Tasks do not, and the Hub hides
  the Scope control while they are shown. Whether the picker shows a Connected Account that has
  nothing for the current App is a rendering question handed to the Settings prototype.
- **Apps whose collections replicate whole contribute local hits to the Command Palette**, beneath
  commands and mail hits, so the "one place to type" rule holds without touching the Search Index
  ([ADR-0016](0016-search-runs-in-the-sync-backend-over-a-bounded-candidate-window.md)). In-App
  controls are filters on a view (Label chips), never a second search field.
- **URL rule**: an entity page gets a path segment (`/notes/:noteId`, later `/contacts/:contactId`),
  a view snapshot gets search params (`/mail?thread=`, and the Calendar's date and view). Mail's
  shape is unchanged; Notes is the first path-param route.
- **Amends ADR-0011**: the collection list grows per App, the scope kinds grow from two to three, and
  Label leaves Mail Account scope.
