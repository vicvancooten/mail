# A Contact holds its Origin's shape; duplicates across Origins link rather than merge

The Contacts App ([#158](https://github.com/vicvancooten/mail/issues/158)) mirrors address books
from Google, Microsoft Graph and CardDAV beside a Local Address Book, and the research in
[docs/research/0010-contacts-sync-and-model.md](../research/0010-contacts-sync-and-model.md) showed
the three upstreams disagree on nearly every field family: how many organisations, whether a
birthday may omit its year, whether an email has a type, how many addresses fit. Rather than one
rich Contact that every upstream holds only part of, **a Contact holds exactly the fields its Origin
can hold**, declared per Origin by that Origin's adapter, and the Local Address Book holds the full
set. When the same person exists in two Address Books, Wicket **links** the two Contacts into one
card rather than merging them, because neither upstream can hold the other's fields. Decided in the
#167 grilling, 2026-09-07.

## Considered Options

- **A superset Contact with one-way loss**: the mirror holds the richest shape, each adapter writes
  what its upstream can take and keeps the rest only in Wicket. Rejected. The mirror stops being a
  mirror for exactly the fields where upstreams disagree: a conflict rollback under
  [ADR-0010](0010-store-as-truth-with-a-pending-mutation-overlay.md)'s upstream-wins rule would have
  to explain a second organisation the upstream never saw, and a Contact edited on the phone would
  silently diverge from the one in Wicket. Per-Origin shape keeps every field on a synced Contact
  round-trippable, so upstream-wins is always the whole truth.
- **A common-denominator Contact everywhere**: rejected. It throws away Google's typed emails and
  year-less birthdays for Users who never connect a Graph account, and makes the Local Address Book
  poorer than any upstream.
- **A real merge across Origins**: pick a survivor, copy what fits, delete the other upstream.
  Rejected for v1. Under per-Origin shape a cross-Origin merge is lossy by construction, and it
  deletes a record from an upstream the User may also use from a phone. Linked Contacts (the
  iOS and Android posture) show one person while every record stays where it is; a real Merge is
  offered only within one Address Book, where nothing is lost.

## Consequences

- **Each Origin's adapter declares a field-capability table**: which families, how many of each,
  which types, whether a date may omit its year, whether Custom Fields are held. The edit form for a
  Contact is drawn from its Origin's table, so a Graph Contact never offers a second organisation
  and a Google Contact does. The Local Address Book's table is the superset.
- **Properties Wicket does not model are preserved, never rewritten**: Google and Graph updates are
  field-masked, and for CardDAV the Sync Backend keeps the last raw vCard per Contact and
  re-serialises only the modelled properties into it before `PUT`.
- **Custom Fields** carry the long tail: typed (text, date, number, phone, location, website) and
  labelled, and any standard value with a label outside the fixed vocabulary is a Custom Field of
  that type. Google holds them in its free-typed families plus `userDefined`; CardDAV in `TEL`/`URL`
  with an x-type and a Wicket-namespaced `X-` property for the rest; Graph holds none.
- **Wicket owns the Contact's identity**: a client-generated ULID, with the upstream id and
  concurrency token held beside it on the Sync Backend only. A Restore from Recently Deleted keeps
  the id and creates a new upstream record; a Copy to another Address Book is a new Contact linked
  to the original.
- **Linked Contacts are a User-scoped link**, never a change to any record: the union of fields shows
  on one Person Page, each field edited in the record it came from, and the record in the Default
  Address Book fronts the card. Delete on a linked card deletes every record, one Undo restores all.
- **Duplicate detection suggests, never acts**: shared normalised email or E.164 phone across
  Account Scope, surfaced as a chip on the card and a filter on the list; same-Address-Book pairs
  offer Merge, cross-Origin pairs offer Link.
- **Labels and upstream groups stay separate**: Wicket Labels apply to Contacts and are never written
  upstream; Google groups, Graph categories and vCard `CATEGORIES` are shown read-only, because the
  three scoping models cannot be reconciled without leaking scope.
