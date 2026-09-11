import type { CollectionDelta } from "@mail/shared";
import {
  ADDRESS_BOOK_TOKEN_KEY,
  type ApplyDeltaOptions,
  applyAddressBookDelta,
  applyCalendarDelta,
  applyCompositionDelta,
  applyConnectedAccountAddressBookDelta,
  applyConnectedAccountContactDelta,
  applyConnectedAccountDelta,
  applyContactDelta,
  applyContactLinkDelta,
  applyContactRollbackDelta,
  applyCorrespondentDelta,
  applyEventDelta,
  applyGmailLabelDelta,
  applyLabelDelta,
  applyMailAccountDelta,
  applyNoteDelta,
  applyPreferenceDelta,
  applyRollbackDelta,
  applyTaskDelta,
  applyTaskListDelta,
  applyThreadDelta,
  CALENDAR_TOKEN_KEY,
  CONNECTED_ACCOUNT_TOKEN_KEY,
  CONTACT_LINK_TOKEN_KEY,
  CONTACT_ROLLBACK_TOKEN_KEY,
  CONTACT_TOKEN_KEY,
  compositionTokenKey,
  connectedAccountAddressBookTokenKey,
  connectedAccountContactTokenKey,
  correspondentTokenKey,
  EVENT_TOKEN_KEY,
  gmailLabelTokenKey,
  LABEL_TOKEN_KEY,
  MAIL_ACCOUNT_TOKEN_KEY,
  NOTE_TOKEN_KEY,
  PREFERENCE_TOKEN_KEY,
  ROLLBACK_TOKEN_KEY,
  TASK_LIST_TOKEN_KEY,
  TASK_TOKEN_KEY,
  threadTokenKey,
} from "../store/server-writes.js";

/**
 * The one collection registry (#185). Every collection this Client holds —
 * wire name, Local Cache table, state-token key, and the function that
 * applies a delta to the table — is declared exactly once, here, split into
 * the three scopes the wire protocol itself has
 * (`packages/shared/src/sync.ts`: `userSyncRequestSchema`/
 * `userSyncResponseSchema` vs. `mailAccountSyncRequestSchema`/
 * `mailAccountSyncResponseSchema` vs. `connectedAccountSyncRequestSchema`/
 * `connectedAccountSyncResponseSchema`, #209). `sync-round.ts` reads these
 * three arrays and nothing else to build a request and apply a response, so
 * a new collection is one entry here rather than a matching edit in the
 * request builder, the apply pass, and the orphan-cleanup list.
 *
 * Payload types differ per collection (`Thread`, `Label`, a `Preference`
 * row, ...), so the arrays below are necessarily non-generic — `apply`'s
 * declared type is `CollectionDelta<unknown>`, the one shape every
 * collection's delta shares. `asApplyUserDelta`/`asApplyMailAccountDelta`
 * are the single, deliberate place that erases each entry's real Payload
 * type down to that common shape; every other line here stays fully typed
 * against the concrete `apply*Delta` function it wraps.
 */

/** The Local Cache (Dexie) table one collection's rows live in. */
export type CollectionTable =
  | "mailAccounts"
  | "preferences"
  | "threads"
  | "labels"
  | "gmailLabels"
  | "compositions"
  | "correspondents"
  | "notes"
  | "taskLists"
  | "tasks"
  | "connectedAccounts"
  | "addressBooks"
  | "contacts"
  | "contactRollbacks"
  | "contactLinks"
  | "calendars"
  | "events"
  | "rollbacks";

type ApplyUserCollectionDelta = (
  delta: CollectionDelta<unknown>,
  options: ApplyDeltaOptions,
) => Promise<void>;

type ApplyMailAccountCollectionDelta = (
  mailAccountId: string,
  delta: CollectionDelta<unknown>,
  options: ApplyDeltaOptions,
) => Promise<void>;

/** A Connected-Account-scoped collection's `apply` shape — `ApplyMailAccountCollectionDelta`'s sibling (#209), same signature keyed by a different id. */
type ApplyConnectedAccountCollectionDelta = (
  connectedAccountId: string,
  delta: CollectionDelta<unknown>,
  options: ApplyDeltaOptions,
) => Promise<void>;

function asApplyUserDelta<Payload>(
  apply: (delta: CollectionDelta<Payload>, options: ApplyDeltaOptions) => Promise<void>,
): ApplyUserCollectionDelta {
  return apply as ApplyUserCollectionDelta;
}

function asApplyMailAccountDelta<Payload>(
  apply: (
    mailAccountId: string,
    delta: CollectionDelta<Payload>,
    options: ApplyDeltaOptions,
  ) => Promise<void>,
): ApplyMailAccountCollectionDelta {
  return apply as ApplyMailAccountCollectionDelta;
}

function asApplyConnectedAccountDelta<Payload>(
  apply: (
    connectedAccountId: string,
    delta: CollectionDelta<Payload>,
    options: ApplyDeltaOptions,
  ) => Promise<void>,
): ApplyConnectedAccountCollectionDelta {
  return apply as ApplyConnectedAccountCollectionDelta;
}

/** A User-scoped collection: `userSyncRequestSchema`/`userSyncResponseSchema`'s keys. */
export interface UserCollectionEntry {
  readonly wireKey:
    | "MailAccount"
    | "Preference"
    | "Label"
    | "Note"
    | "TaskList"
    | "Task"
    | "ConnectedAccount"
    | "AddressBook"
    | "Contact"
    | "ContactRollback"
    | "ContactLink"
    | "Calendar"
    | "Event"
    | "Rollback";
  readonly table: CollectionTable;
  readonly tokenKey: string;
  readonly apply: ApplyUserCollectionDelta;
}

/** A per-Mail-Account collection: `mailAccountSyncRequestSchema`/`mailAccountSyncResponseSchema`'s four keys. */
export interface MailAccountCollectionEntry {
  readonly wireKey: "Thread" | "GmailLabel" | "Composition" | "Correspondent";
  readonly table: CollectionTable;
  readonly tokenKey: (mailAccountId: string) => string;
  readonly apply: ApplyMailAccountCollectionDelta;
}

/** A per-Connected-Account collection (#209): `connectedAccountSyncRequestSchema`/`connectedAccountSyncResponseSchema`'s two keys — `AddressBook`/`Contact`'s own mirrored half, `MailAccountCollectionEntry`'s sibling. */
export interface ConnectedAccountCollectionEntry {
  readonly wireKey: "AddressBook" | "Contact";
  readonly table: CollectionTable;
  readonly tokenKey: (connectedAccountId: string) => string;
  readonly apply: ApplyConnectedAccountCollectionDelta;
}

export const USER_COLLECTIONS: readonly UserCollectionEntry[] = [
  {
    wireKey: "MailAccount",
    table: "mailAccounts",
    tokenKey: MAIL_ACCOUNT_TOKEN_KEY,
    apply: asApplyUserDelta(applyMailAccountDelta),
  },
  {
    wireKey: "Preference",
    table: "preferences",
    tokenKey: PREFERENCE_TOKEN_KEY,
    apply: asApplyUserDelta(applyPreferenceDelta),
  },
  // `Label` moved here from `MAIL_ACCOUNT_COLLECTIONS` in #186 (ADR-0023) —
  // one set of Labels per User rather than one per Mail Account. Moving it
  // was this entry and its `apply`'s own signature; `sync-round.ts` never
  // learned it happened, which is what #185 built this registry for.
  {
    wireKey: "Label",
    table: "labels",
    tokenKey: LABEL_TOKEN_KEY,
    apply: asApplyUserDelta(applyLabelDelta),
  },
  // `Note` (#192, ADR-0023): this registry's first genuinely new member
  // rather than a migrated one — see `applyNoteDelta`'s own doc comment for
  // the one place it differs from `Label`'s no-merge shape.
  {
    wireKey: "Note",
    table: "notes",
    tokenKey: NOTE_TOKEN_KEY,
    apply: asApplyUserDelta(applyNoteDelta),
  },
  // `TaskList`/`Task` (#251, ADR-0030): this registry's next new members
  // after `Note` — the same one-declaration shape, no hand-written sync
  // function for either.
  {
    wireKey: "TaskList",
    table: "taskLists",
    tokenKey: TASK_LIST_TOKEN_KEY,
    apply: asApplyUserDelta(applyTaskListDelta),
  },
  {
    wireKey: "Task",
    table: "tasks",
    tokenKey: TASK_TOKEN_KEY,
    apply: asApplyUserDelta(applyTaskDelta),
  },
  // `ConnectedAccount` (#199, #200, ADR-0022): `Note`'s sibling above — a
  // plain whole-replicated User-scoped table, no merge rule of its own.
  {
    wireKey: "ConnectedAccount",
    table: "connectedAccounts",
    tokenKey: CONNECTED_ACCOUNT_TOKEN_KEY,
    apply: asApplyUserDelta(applyConnectedAccountDelta),
  },
  // `AddressBook`/`Contact` (#209, ADR-0023): the Local Address Book's own
  // slot — a mirrored book or Contact rides `CONNECTED_ACCOUNT_COLLECTIONS`
  // below instead, same `addressBooks`/`contacts` table, different scope.
  {
    wireKey: "AddressBook",
    table: "addressBooks",
    tokenKey: ADDRESS_BOOK_TOKEN_KEY,
    apply: asApplyUserDelta(applyAddressBookDelta),
  },
  {
    wireKey: "Contact",
    table: "contacts",
    tokenKey: CONTACT_TOKEN_KEY,
    apply: asApplyUserDelta(applyContactDelta),
  },
  // `ContactRollback` (#216, ADR-0023): `Contact`'s append-only sibling —
  // `@mail/shared#contactRollbackSchema`'s own doc comment.
  {
    wireKey: "ContactRollback",
    table: "contactRollbacks",
    tokenKey: CONTACT_ROLLBACK_TOKEN_KEY,
    apply: asApplyUserDelta(applyContactRollbackDelta),
  },
  // `ContactLink` (#222, ADR-0026): User-scoped only — no
  // `CONNECTED_ACCOUNT_COLLECTIONS` sibling, since a link spans Origins by
  // construction. Declared **after** `Contact` on purpose: these are applied
  // in order within a round, and a link only means anything once the
  // Contacts it names are in the cache.
  {
    wireKey: "ContactLink",
    table: "contactLinks",
    tokenKey: CONTACT_LINK_TOKEN_KEY,
    apply: asApplyUserDelta(applyContactLinkDelta),
  },
  // `Calendar` and `Rollback` (#229): `Note`'s shape exactly, whole-replicated
  // and User-scoped from the start.
  {
    wireKey: "Calendar",
    table: "calendars",
    tokenKey: CALENDAR_TOKEN_KEY,
    apply: asApplyUserDelta(applyCalendarDelta),
  },
  {
    wireKey: "Rollback",
    table: "rollbacks",
    tokenKey: ROLLBACK_TOKEN_KEY,
    apply: asApplyUserDelta(applyRollbackDelta),
  },
  // `Event` (#229): the one windowed User-scoped collection — its delta
  // carries `windowStart`/`windowEnd` alongside the ordinary fields, which is
  // a strictly *wider* shape than `CollectionDelta<Event>`, so `applyEventDelta`
  // cannot go through `asApplyUserDelta`'s generic erasure (that would need
  // the reverse, narrowing cast). Erased by hand here instead — the one
  // place this registry's "erase to `CollectionDelta<unknown>`" contract
  // does not literally hold, because `sync-round.ts` hands this `apply` the
  // full parsed `EventDelta` object, extra fields and all.
  {
    wireKey: "Event",
    table: "events",
    tokenKey: EVENT_TOKEN_KEY,
    apply: applyEventDelta as unknown as ApplyUserCollectionDelta,
  },
];

export const MAIL_ACCOUNT_COLLECTIONS: readonly MailAccountCollectionEntry[] = [
  {
    wireKey: "Thread",
    table: "threads",
    tokenKey: threadTokenKey,
    apply: asApplyMailAccountDelta(applyThreadDelta),
  },
  {
    wireKey: "GmailLabel",
    table: "gmailLabels",
    tokenKey: gmailLabelTokenKey,
    apply: asApplyMailAccountDelta(applyGmailLabelDelta),
  },
  {
    wireKey: "Composition",
    table: "compositions",
    tokenKey: compositionTokenKey,
    apply: asApplyMailAccountDelta(applyCompositionDelta),
  },
  {
    wireKey: "Correspondent",
    table: "correspondents",
    tokenKey: correspondentTokenKey,
    apply: asApplyMailAccountDelta(applyCorrespondentDelta),
  },
];

/**
 * The two Connected-Account-scoped collections (#209) — `AddressBook`'s and
 * `Contact`'s own mirrored half, `USER_COLLECTIONS`' Local half's sibling.
 * Both are empty for every Connected Account today (no upstream adapter
 * mirrors one yet, #214+), same posture the Sync Backend's own
 * `connectedAccountCollectionRegistry` is in.
 */
export const CONNECTED_ACCOUNT_COLLECTIONS: readonly ConnectedAccountCollectionEntry[] = [
  {
    wireKey: "AddressBook",
    table: "addressBooks",
    tokenKey: connectedAccountAddressBookTokenKey,
    apply: asApplyConnectedAccountDelta(applyConnectedAccountAddressBookDelta),
  },
  {
    wireKey: "Contact",
    table: "contacts",
    tokenKey: connectedAccountContactTokenKey,
    apply: asApplyConnectedAccountDelta(applyConnectedAccountContactDelta),
  },
];
