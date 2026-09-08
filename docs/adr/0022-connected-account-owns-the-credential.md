# A Connected Account owns the credential; a Mail Account is its Mail Facet

Calendar and Contacts sync ([#158](https://github.com/vicvancooten/mail/issues/158)) need a place to
hang a Google or Microsoft consent that is not about mail, and a place for a CalDAV/CardDAV login
that never is. Rather than growing the Mail Account or adding a sibling with its own sign-in, the
credential moves one level up: a **Connected Account** is one identity at one Provider, owned by one
User, holding exactly one Grant or password, and carrying one or more **Facets** (Mail, Calendar,
Contacts). The Mail Account becomes the Mail Facet, at most one per Connected Account. This applies
universally: every existing Mail Account, Other IMAP included, migrates under a Connected Account
with a single Mail Facet. Decided in the #165 grilling, 2026-09-07.

## Considered Options

- **Connected Account only for Providers that can carry more than mail** (Google, Microsoft,
  CalDAV/CardDAV), Other IMAP Mail Accounts left standalone: rejected. It saves the migration and
  buys two account lists in Settings and two Needs Reauth code paths for good.
- **A sibling Connected Account with its own Grant for calendar and contacts**: rejected. A Google
  User would sign in twice and hold two refresh tokens on the same OAuth client, and since Google's
  incremental authorization returns a token covering *all* previously granted scopes, the two Grants
  would overlap in ways neither the User nor the code could reason about. Needs Reauth on one and
  not the other would have no visible cause.
- **One Grant per Facet on a shared Connected Account**: rejected. Microsoft's identity platform
  does not model it (consent is additive on one grant per user and client), and it would consume
  Google's 100-refresh-tokens-per-account-per-client cap three times as fast.
- **Origin per Event and per Contact** rather than per collection: rejected. It turns merging and
  moving into per-item provenance questions; Origin on the Calendar or Address Book makes "copy into
  a Local address book" the answer, as in every other client.
- **Folding Other IMAP and CalDAV/CardDAV into one "Other" Provider sharing a password**, since
  Fastmail and iCloud issue one app password for both: rejected. The credentials are entered
  separately anyway, the servers differ, and Nextcloud and Radicale have no mail. A Fastmail User
  has two Connected Accounts, which is honest.

## Consequences

- **The stored credential moves from `mail_accounts` to the Connected Account row**, keeping the
  `password | oauth` tagged union and the sealed-secret scheme of
  [ADR-0003](0003-instance-held-credential-key.md); the AEAD's associated data becomes the Connected
  Account id. This is a data migration of every existing account, done once.
- **One Grant, a growing scope set.** Turning on a Facet runs the Provider's consent flow on the
  same Provider Registration ([ADR-0021](0021-provider-registration-is-per-instance-and-owner-entered.md))
  for that Facet's scopes only (`include_granted_scopes=true` for Google; Microsoft is additive by
  default and needs one authorize round per resource because IMAP and Graph are different audiences,
  so access tokens are minted per resource from the one refresh token). The address the Provider
  returns must match the Connected Account's identity, exactly as reauth already demands. If Google
  returns a fresh refresh token it replaces the stored one; otherwise the stored one is kept and only
  the scope set widens. First sign-in asks only for the Facet requested, never for calendar or
  contacts speculatively; connecting Google for Calendar first and Mail later is the same flow in
  the other order.
- **Needs Reauth has two levels, one name.** On the Connected Account when the credential is
  rejected or the Grant withdrawn (every Facet stops); on a single Facet when only its consent is
  refused, as when the User revokes one permission upstream (that Facet stops, the others continue).
  In both, mirrored data stays readable and pending Optimistic Actions wait
  ([ADR-0010](0010-store-as-truth-with-a-pending-mutation-overlay.md)). A CalDAV/CardDAV 401 is
  always the account level, since both Facets share the password.
- **Owner-only failures never show as Needs Reauth.** Google requires the Calendar API and People
  API to be enabled on the Owner's Cloud project; a 403 for a missing API is a Registration problem.
  Provider Health gains a per-Facet reading (ever granted, currently honoured, API enabled), and the
  Member sees the Facet as unavailable on this instance with "ask the Owner", the same treatment an
  unregistered Provider gets. CalDAV/CardDAV and Other IMAP need no Registration and stay absent
  from Provider Health.
- **A CalDAV/CardDAV Connected Account** holds a server or email address to discover from, a
  username, an app password, and per Facet the discovered principal and home-set URLs plus whether
  the server speaks RFC 6638 scheduling. Discovery runs separately per Facet because iCloud serves
  each from a different host.
- **Ownership is unchanged in kind**: a Connected Account belongs to exactly one User
  ([ADR-0004](0004-mail-account-belongs-to-one-user.md)), is unique per User, Provider and identity,
  and two Users may each connect the same upstream account with their own credentials and mirror.
- **The Other IMAP to Google switch survives.** ADR-0021's promise that a Gmail account added with
  an app password can switch to a Grant when the signed-in address matches becomes a Connected
  Account changing Provider, keeping its id, its Mail Facet and every synced message, and becoming
  eligible for Calendar and Contacts.
- **Origin lives on the collection.** A Calendar or Address Book has exactly one Origin, a Connected
  Account or Local; Events and Contacts inherit it. Local is not a Connected Account: no Provider,
  no credential, never Needs Reauth. The word deliberately stays "Local" despite the Client's Local
  Cache, because it is what every calendar client calls it; the glossary disambiguates both.
- **Account Scope becomes a subset of Connected Accounts.** Mail shows the Mail Facets in scope,
  Calendar and Contacts the collections whose Origin is in scope, and Local collections are always
  in scope. A Calendar-only Google Connected Account appears in the picker even though Mail shows
  nothing for it; how the picker renders that belongs to the shared App plumbing.
- **Removing a Connected Account or a Facet** is its own decision
  ([#180](https://github.com/vicvancooten/mail/issues/180)); the opening position is that a Facet's
  mirror is discarded on removal, the last Facet takes the Connected Account with it, and Local data
  is never touched.
