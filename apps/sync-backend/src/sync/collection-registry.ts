import type { CollectionDelta, EventDelta } from "@mail/shared";
import { NOTE_TRASH_RETENTION_DAYS, TASK_TRASH_RETENTION_DAYS } from "@mail/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import {
  ensureLocalAddressBook,
  selectAddressBooksForConnectedAccount,
  selectAddressBooksForUser,
  toWireAddressBook,
} from "../address-books/store.js";
import { computeEventWindow, toWireEvent } from "../calendars/event-store.js";
import { toWireRollback } from "../calendars/rollback-store.js";
import { ensurePersonalCalendar, toWireCalendar } from "../calendars/store.js";
import {
  selectConnectedAccountsForUser,
  toWireConnectedAccount,
} from "../connected-accounts/store.js";
import { selectContactLinksForUser, toWireContactLink } from "../contacts/link-store.js";
import {
  selectContactRollbacksForUser,
  toWireContactRollback,
} from "../contacts/rollback-store.js";
import {
  selectContactsForConnectedAccount,
  selectContactsForUser,
  toWireContact,
} from "../contacts/store.js";
import type { Db } from "../db/client.js";
import {
  addressBooks,
  calendars,
  compositions,
  connectedAccounts,
  contactLinks,
  contactRollbacks,
  contacts,
  correspondents,
  events,
  gmailLabels,
  labels,
  mailAccounts,
  notes,
  rollbacks,
  syncTombstones,
  taskLists,
  tasks,
  threads,
  users,
} from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { toWireMailAccount } from "../mail-accounts/store.js";
import {
  buildDelta,
  PAGE_SIZE,
  type SyncRevRow,
  syncMailAccountCollection,
  syncPreferenceCollection,
  syncThreadCollection,
  toWirePreference,
} from "./collection-sync.js";
import { resolveCursor } from "./sync-tokens.js";
import { ensureDefaultTaskList } from "./task-list-store.js";
import {
  toWireComposition,
  toWireCorrespondent,
  toWireGmailLabel,
  toWireLabel,
  toWireNote,
  toWireTask,
  toWireTaskList,
  toWireThread,
} from "./thread-projection.js";

/**
 * The Sync Backend's collection registry (#184): every collection `POST
 * /sync` answers for is declared here once — its wire name, its Sync Scope,
 * and its row→wire projection — instead of a hand-written call list with a
 * branch per collection inside `routes/sync.ts`. That route iterates
 * `userCollectionRegistry`/`mailAccountCollectionRegistry`/
 * `connectedAccountCollectionRegistry` bucketed by which scopes the request
 * actually carries; nothing there names a collection by hand any more. This
 * is the prefactor ADR-0023's later App collections land on: one
 * declaration here, not six edits across six files.
 *
 * `connectedAccount` was declared as an accepted `ScopeKind` with no member
 * for months — `AddressBook`/`Contact` (#209) are its first real users, the
 * branch this comment used to call a documented no-op.
 */
export type ScopeKind = "user" | "mailAccount" | "connectedAccount";

/** The context a User-scoped descriptor's `sync` is invoked with. */
export interface UserScopeContext {
  userId: string;
}

/**
 * The context a Mail-Account-scoped descriptor's `sync` is invoked with.
 * `account` rides along (not just its id) because `Thread`'s descriptor
 * needs its `threadsEpoch` (`db/schema.ts`) — the route already has the row
 * in hand from its ownership check, so every descriptor gets it for free
 * rather than each re-fetching what it happens to need.
 */
export interface MailAccountScopeContext {
  mailAccountId: string;
  account: MailAccountRow;
}

/** The context a Connected-Account-scoped descriptor's `sync` is invoked with — `MailAccountScopeContext`'s sibling (#209), minus a row-specific field to ride along: neither `AddressBook` nor `Contact` needs anything off the Connected Account row itself. */
export interface ConnectedAccountScopeContext {
  connectedAccountId: string;
}

/**
 * The declared, non-executable half of a descriptor: `table` and
 * `toPayload` are data, kept alongside the `sync` behaviour rather than
 * buried inside it, so a collection's source table and wire projection are
 * things this registry visibly *says* rather than things one has to read a
 * closure to find. `toPayload`'s parameter is typed `never` rather than the
 * collection's real row type — which varies per collection — precisely so
 * heterogeneous descriptors can share one array; nothing here ever calls it
 * polymorphically, each `sync` closure already carries its own
 * correctly-typed projection.
 */
/**
 * A collection's own soft-delete purge sweep (#257, generalising #194's
 * Note-only `note-purge.ts` into `sync/trash-purge.ts`'s registry-driven
 * loop): declaring this is what opts a collection into that shared sweep,
 * rather than a second bespoke loop per collection that grows one. `deletedAt`
 * and `id` are direct column references into `table` above (every
 * retention-bearing collection here names its primary key plainly `id`,
 * `taskListRow`/`taskRow`'s own "`noteRow`'s own shape" precedent) — kept as
 * data alongside `table`/`toPayload` rather than derived from them, the same
 * "declared, not computed" posture `DeclaredCollection`'s own doc comment
 * already takes.
 */
interface TombstoneRetention {
  /** The soft-delete timestamp column this collection's rows carry — null for a live row, stamped the moment a soft delete happens. */
  deletedAt: AnyPgColumn;
  /** The row's own primary key column, for `trash-purge.ts` to select and delete by. */
  id: AnyPgColumn;
  /** Days after `deletedAt` is stamped before a row is purged for good. */
  days: number;
}

interface DeclaredCollection {
  name: string;
  /** The row source this collection reads from. Tombstones, for every collection here, are the shared `syncTombstones` table filtered to `collection = name`. */
  table: AnyPgTable;
  toPayload: (row: never) => unknown;
  /** Present only for a collection whose soft-deleted rows are purged for good on a retention window (`Note`, `TaskList`, `Task`) — absent for one with no soft delete at all. */
  retention?: TombstoneRetention;
}

export interface UserCollectionDescriptor<Payload> extends DeclaredCollection {
  scope: "user";
  toPayload: (row: never) => Payload;
  sync: (
    db: Db,
    context: UserScopeContext,
    token: string | null,
  ) => Promise<CollectionDelta<Payload> | null>;
}

export interface MailAccountCollectionDescriptor<Payload> extends DeclaredCollection {
  scope: "mailAccount";
  toPayload: (row: never) => Payload;
  sync: (
    db: Db,
    context: MailAccountScopeContext,
    token: string | null,
  ) => Promise<CollectionDelta<Payload> | null>;
}

export interface ConnectedAccountCollectionDescriptor<Payload> extends DeclaredCollection {
  scope: "connectedAccount";
  toPayload: (row: never) => Payload;
  sync: (
    db: Db,
    context: ConnectedAccountScopeContext,
    token: string | null,
  ) => Promise<CollectionDelta<Payload> | null>;
}

export type CollectionDescriptor<Payload = unknown> =
  | UserCollectionDescriptor<Payload>
  | MailAccountCollectionDescriptor<Payload>
  | ConnectedAccountCollectionDescriptor<Payload>;

/**
 * Declares one User-scoped collection off its source table —
 * `mailAccountScopedCollection`'s sibling, and the shape `Label` (#186) is
 * the first member of. Identical past `selectRows` and the tombstone scope:
 * a User-scoped collection's tombstones are the ones with **no**
 * `mailAccountId` (`db/schema.ts#syncTombstones`), the same filter
 * `collection-sync.ts`'s hand-written `MailAccount`/`Preference` queries
 * already use.
 *
 * `MailAccount` and `Preference` deliberately do *not* go through this
 * factory: neither reads from a table with a `userId` column to filter on
 * (`Preference` matches the User's own `users` row by `id`), which is the
 * same "the registry constrains declaration and dispatch, not query shape"
 * line `Thread` sits on the other side of.
 *
 * The tombstone filter also requires **no** `connectedAccountId` (#209):
 * `AddressBook`/`Contact` widened `sync_tombstones` with that column
 * (`db/schema.ts`), so a User-scoped bucket (`isNull(mailAccountId)` alone,
 * this factory's original filter) would otherwise also catch a mirrored
 * book's tombstones, which belong to its own Connected Account's bucket
 * instead (`connectedAccountScopedCollection` below).
 */
function userScopedCollection<Row extends SyncRevRow, Payload>(config: {
  name: string;
  table: AnyPgTable;
  selectRows: (db: Db, userId: string, cursorRev: number) => Promise<Row[]>;
  toPayload: (row: Row) => Payload;
  /** Opts this collection into `sync/trash-purge.ts`'s shared sweep (#257) — see `TombstoneRetention`'s own doc comment. Omitted for a collection with no soft delete. */
  retention?: TombstoneRetention;
}): UserCollectionDescriptor<Payload> {
  const { name, table, selectRows, toPayload, retention } = config;
  return {
    name,
    scope: "user",
    table,
    toPayload: toPayload as (row: never) => Payload,
    retention,
    async sync(db, { userId }, token) {
      const { rev: cursorRev, needsReset } = resolveCursor(token);

      const rows = await selectRows(db, userId, cursorRev);

      const tombstoneRows = needsReset
        ? []
        : await db
            .select({ entityId: syncTombstones.entityId, syncRev: syncTombstones.syncRev })
            .from(syncTombstones)
            .where(
              and(
                isNull(syncTombstones.mailAccountId),
                isNull(syncTombstones.connectedAccountId),
                eq(syncTombstones.collection, name),
                gt(syncTombstones.syncRev, cursorRev),
              ),
            )
            .orderBy(asc(syncTombstones.syncRev))
            .limit(PAGE_SIZE + 1);

      return buildDelta({
        rows,
        tombstones: tombstoneRows,
        cursorRev,
        needsReset,
        token,
        toPayload,
      });
    },
  };
}

/**
 * Declares one Mail-Account-scoped collection off its source table:
 * `GmailLabel`, `Correspondent` and `Composition` all share the
 * exact same shape past `selectRows` — a page of tombstones from the shared
 * `syncTombstones` table filtered to this collection's name, merged through
 * `buildDelta` — so this factory is that shared shape lifted out once rather
 * than copy-pasted per collection (the four hand-written `sync*Collection`
 * functions #184 removed from `collection-sync.ts`). `selectRows` is still
 * supplied per collection rather than derived generically from `table`:
 * Drizzle's column types are not friendly to a fully generic "any table with
 * a `mailAccountId` column" query built inside this function, so each
 * collection's own (one-line) query stays next to its own table reference,
 * the same way `toPayload` does. `Thread`'s own descriptor below does not go
 * through this factory at all: its windowed, rebuild-epoch-aware query is
 * genuinely its own, not this shape.
 */
function mailAccountScopedCollection<Row extends SyncRevRow, Payload>(config: {
  name: string;
  table: AnyPgTable;
  selectRows: (db: Db, mailAccountId: string, cursorRev: number) => Promise<Row[]>;
  toPayload: (row: Row) => Payload;
}): MailAccountCollectionDescriptor<Payload> {
  const { name, table, selectRows, toPayload } = config;
  return {
    name,
    scope: "mailAccount",
    table,
    toPayload: toPayload as (row: never) => Payload,
    async sync(db, { mailAccountId }, token) {
      const { rev: cursorRev, needsReset } = resolveCursor(token);

      const rows = await selectRows(db, mailAccountId, cursorRev);

      const tombstoneRows = needsReset
        ? []
        : await db
            .select({ entityId: syncTombstones.entityId, syncRev: syncTombstones.syncRev })
            .from(syncTombstones)
            .where(
              and(
                eq(syncTombstones.mailAccountId, mailAccountId),
                eq(syncTombstones.collection, name),
                gt(syncTombstones.syncRev, cursorRev),
              ),
            )
            .orderBy(asc(syncTombstones.syncRev))
            .limit(PAGE_SIZE + 1);

      return buildDelta({
        rows,
        tombstones: tombstoneRows,
        cursorRev,
        needsReset,
        token,
        toPayload,
      });
    },
  };
}

/**
 * Declares one Connected-Account-scoped collection off its source table
 * (#209) — `userScopedCollection`'s sibling, keyed by `connectedAccountId`
 * instead of `userId`: `AddressBook`/`Contact`'s own scope, and the first
 * real member of it. Tombstones are the ones whose `connectedAccountId`
 * matches, the same shape `mailAccountScopedCollection`'s own filter has.
 */
function connectedAccountScopedCollection<Row extends SyncRevRow, Payload>(config: {
  name: string;
  table: AnyPgTable;
  selectRows: (db: Db, connectedAccountId: string, cursorRev: number) => Promise<Row[]>;
  toPayload: (row: Row) => Payload;
}): ConnectedAccountCollectionDescriptor<Payload> {
  const { name, table, selectRows, toPayload } = config;
  return {
    name,
    scope: "connectedAccount",
    table,
    toPayload: toPayload as (row: never) => Payload,
    async sync(db, { connectedAccountId }, token) {
      const { rev: cursorRev, needsReset } = resolveCursor(token);

      const rows = await selectRows(db, connectedAccountId, cursorRev);

      const tombstoneRows = needsReset
        ? []
        : await db
            .select({ entityId: syncTombstones.entityId, syncRev: syncTombstones.syncRev })
            .from(syncTombstones)
            .where(
              and(
                eq(syncTombstones.connectedAccountId, connectedAccountId),
                eq(syncTombstones.collection, name),
                gt(syncTombstones.syncRev, cursorRev),
              ),
            )
            .orderBy(asc(syncTombstones.syncRev))
            .limit(PAGE_SIZE + 1);

      return buildDelta({
        rows,
        tombstones: tombstoneRows,
        cursorRev,
        needsReset,
        token,
        toPayload,
      });
    },
  };
}

/**
 * The fourteen User-scoped collections (ADR-0011, ADR-0025). `MailAccount`
 * and `Preference` are each a thin wrapper around `collection-sync.ts`'s own
 * hand-written query — see `userScopedCollection`'s doc comment for why
 * neither goes through it. `Label` (#186), `Note` (#192, ADR-0023),
 * `TaskList`/`Task` (#251, ADR-0030), `ConnectedAccount` (#200), `Calendar`
 * and `Rollback` (#229) all do: each is a plain `userId`-filtered table
 * replicating whole. `Label` moved here from `mailAccountCollectionRegistry`
 * by changing exactly its declaration; `Note` (#192) is this registry's
 * first **new** member rather than a migrated one — the same one-declaration
 * shape either way, which is what #184 built the registry for.
 * `ConnectedAccount`'s own `selectRows` is the one that isn't a one-line
 * `db.select().from(...)` — it joins each account to its own Facets
 * (`connected-accounts/store.ts#selectConnectedAccountsForUser`), the wire
 * shape ADR-0022 asks for — but is otherwise exactly this same shape.
 * `Event` (#229) is the one windowed member — `userScopedCollection` has no
 * room for the window edges its delta carries alongside the ordinary
 * fields, so it is declared by hand below the array, the same "the registry
 * constrains declaration and dispatch, not query shape" line `Thread` sits
 * on the other side of.
 *
 * `AddressBook`/`Contact` (#209) are this slot's own **Local** half only —
 * a mirrored book or Contact rides `connectedAccountCollectionRegistry`
 * below instead, same row shape, different scope. `AddressBook`'s
 * `selectRows` mints the Local Address Book first (`ensureLocalAddressBook`)
 * — the only member here that ever *writes* before it reads.
 *
 * `Calendar` and `Event` are still declared `scope: "user"` here rather than
 * `"connectedAccount"` even though ADR-0025 gives both scopes and this merge
 * lands the real Connected Account model (#200) onto this branch's line at
 * last — #234 ("Google Calendar mirrors a Calendar") shipped against a
 * null-injected placeholder for it, and wiring the genuine
 * `connectedAccount`-scoped path (the registry/route-dispatch machinery
 * `ScopeKind`'s doc comment above anticipates) is #235's own work, not this
 * merge's.
 */
export const userCollectionRegistry: readonly UserCollectionDescriptor<unknown>[] = [
  {
    name: "MailAccount",
    scope: "user",
    table: mailAccounts,
    toPayload: toWireMailAccount as (row: never) => unknown,
    sync: (db, { userId }, token) => syncMailAccountCollection(db, userId, token),
  },
  {
    name: "Preference",
    scope: "user",
    table: users,
    toPayload: toWirePreference as (row: never) => unknown,
    sync: (db, { userId }, token) => syncPreferenceCollection(db, userId, token),
  },
  userScopedCollection({
    name: "Label",
    table: labels,
    selectRows: (db, userId, cursorRev) =>
      db
        .select()
        .from(labels)
        .where(and(eq(labels.userId, userId), gt(labels.syncRev, cursorRev)))
        .orderBy(asc(labels.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireLabel,
  }),
  userScopedCollection({
    name: "Note",
    table: notes,
    selectRows: (db, userId, cursorRev) =>
      db
        .select()
        .from(notes)
        .where(and(eq(notes.userId, userId), gt(notes.syncRev, cursorRev)))
        .orderBy(asc(notes.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireNote,
    // #257: `trash-purge.ts`'s registry-driven sweep reads this rather than
    // `note-purge.ts` naming `notes` by hand.
    retention: { deletedAt: notes.deletedAt, id: notes.id, days: NOTE_TRASH_RETENTION_DAYS },
  }),
  // `TaskList` (#251, ADR-0030): `Note`'s sibling, plus a seed
  // (`ensureDefaultTaskList`) run ahead of every query — see that
  // function's own doc comment for why running it unconditionally on every
  // call is what "seeded on first sync" means in practice.
  userScopedCollection({
    name: "TaskList",
    table: taskLists,
    selectRows: async (db, userId, cursorRev) => {
      await ensureDefaultTaskList(db, userId);
      return db
        .select()
        .from(taskLists)
        .where(and(eq(taskLists.userId, userId), gt(taskLists.syncRev, cursorRev)))
        .orderBy(asc(taskLists.syncRev))
        .limit(PAGE_SIZE + 1);
    },
    toPayload: toWireTaskList,
    // #257: joins `Note`'s own purge sweep rather than staying un-purged.
    retention: {
      deletedAt: taskLists.deletedAt,
      id: taskLists.id,
      days: TASK_TRASH_RETENTION_DAYS,
    },
  }),
  // `Task` (#251, ADR-0030): `Note`'s other sibling — no completed-Task
  // filter, no window ("replicated whole ... completed Tasks are included
  // in replication and never windowed out").
  userScopedCollection({
    name: "Task",
    table: tasks,
    selectRows: (db, userId, cursorRev) =>
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.userId, userId), gt(tasks.syncRev, cursorRev)))
        .orderBy(asc(tasks.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireTask,
    // #257: joins the same sweep — `trash-purge.ts`'s own doc comment covers
    // why it stays correct regardless of this array's declaration order,
    // even though a Task's row can also vanish via `taskLists`' own
    // `ON DELETE CASCADE` when its List is purged first.
    retention: { deletedAt: tasks.deletedAt, id: tasks.id, days: TASK_TRASH_RETENTION_DAYS },
  }),
  userScopedCollection({
    name: "ConnectedAccount",
    table: connectedAccounts,
    selectRows: (db, userId, cursorRev) =>
      selectConnectedAccountsForUser(db, userId, cursorRev).limit(PAGE_SIZE + 1),
    toPayload: toWireConnectedAccount,
  }),
  userScopedCollection({
    name: "AddressBook",
    table: addressBooks,
    selectRows: async (db, userId, cursorRev) => {
      await ensureLocalAddressBook(db, userId);
      return selectAddressBooksForUser(db, userId, cursorRev).limit(PAGE_SIZE + 1);
    },
    toPayload: toWireAddressBook,
  }),
  userScopedCollection({
    name: "Contact",
    table: contacts,
    selectRows: (db, userId, cursorRev) =>
      selectContactsForUser(db, userId, cursorRev).limit(PAGE_SIZE + 1),
    toPayload: toWireContact,
  }),
  // `ContactRollback` (#216): append-only, `Contact`'s sibling — see
  // `@mail/shared#contactRollbackSchema`'s own doc comment.
  userScopedCollection({
    name: "ContactRollback",
    table: contactRollbacks,
    selectRows: (db, userId, cursorRev) =>
      selectContactRollbacksForUser(db, userId, cursorRev).limit(PAGE_SIZE + 1),
    toPayload: toWireContactRollback,
  }),
  // `ContactLink` (#222, ADR-0026): User-scoped **only** — unlike
  // `AddressBook`/`Contact` above it has no mirrored half at all, since a
  // link spans Origins by construction and so belongs to no Connected
  // Account's Sync Scope (`@mail/shared#contactLinkSchema`'s own doc
  // comment). Declared after `Contact` deliberately: the Client's own
  // registry applies these in order, and a link is only meaningful once the
  // Contacts it names are in the Local Cache.
  userScopedCollection({
    name: "ContactLink",
    table: contactLinks,
    selectRows: (db, userId, cursorRev) =>
      selectContactLinksForUser(db, userId, cursorRev).limit(PAGE_SIZE + 1),
    toPayload: toWireContactLink,
  }),
  userScopedCollection({
    name: "Calendar",
    table: calendars,
    // `ensurePersonalCalendar` runs on every `Calendar` sync round rather
    // than at signup or server boot: "first use" (#229's acceptance line)
    // means the first time this collection is actually asked for, and
    // `onConflictDoNothing` against a deterministic id makes calling it here
    // on every round harmless.
    selectRows: async (db, userId, cursorRev) => {
      await ensurePersonalCalendar(db, userId);
      return db
        .select()
        .from(calendars)
        .where(and(eq(calendars.userId, userId), gt(calendars.syncRev, cursorRev)))
        .orderBy(asc(calendars.syncRev))
        .limit(PAGE_SIZE + 1);
    },
    toPayload: toWireCalendar,
  }),
  userScopedCollection({
    name: "Rollback",
    table: rollbacks,
    selectRows: (db, userId, cursorRev) =>
      db
        .select()
        .from(rollbacks)
        .where(and(eq(rollbacks.userId, userId), gt(rollbacks.syncRev, cursorRev)))
        .orderBy(asc(rollbacks.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireRollback,
  }),
  {
    name: "Event",
    scope: "user",
    table: events,
    toPayload: toWireEvent as (row: never) => unknown,
    async sync(db, { userId }, token) {
      const { rev: cursorRev, needsReset } = resolveCursor(token);

      const rows = await db
        .select()
        .from(events)
        .where(and(eq(events.userId, userId), gt(events.syncRev, cursorRev)))
        .orderBy(asc(events.syncRev))
        .limit(PAGE_SIZE + 1);

      const tombstoneRows = needsReset
        ? []
        : await db
            .select({ entityId: syncTombstones.entityId, syncRev: syncTombstones.syncRev })
            .from(syncTombstones)
            .where(
              and(
                isNull(syncTombstones.mailAccountId),
                eq(syncTombstones.collection, "Event"),
                gt(syncTombstones.syncRev, cursorRev),
              ),
            )
            .orderBy(asc(syncTombstones.syncRev))
            .limit(PAGE_SIZE + 1);

      const delta = buildDelta({
        rows,
        tombstones: tombstoneRows,
        cursorRev,
        needsReset,
        token,
        toPayload: toWireEvent,
      });
      if (!delta) return null;

      // Both Event Window edges travel in the sync response (#229's
      // acceptance line, ADR-0025) so the Client can draw the window
      // honestly — `MailAccount.indexWatermark`'s own reasoning for mail.
      const window = computeEventWindow();
      const withWindow: EventDelta = {
        ...delta,
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
      };
      return withWindow;
    },
  },
];

/**
 * The four Mail-Account-scoped collections `POST /sync` answers for — the
 * eight User-scoped ones above cover the rest. `Thread` keeps its own
 * windowed query (`collection-sync.ts`) rather than going through
 * `mailAccountScopedCollection` — the registry constrains declaration and
 * dispatch, not query shape (#184).
 */
export const mailAccountCollectionRegistry: readonly MailAccountCollectionDescriptor<unknown>[] = [
  {
    name: "Thread",
    scope: "mailAccount",
    table: threads,
    toPayload: toWireThread as (row: never) => unknown,
    sync: (db, { mailAccountId, account }, token) =>
      syncThreadCollection(db, mailAccountId, account.threadsEpoch, token),
  },
  mailAccountScopedCollection({
    name: "GmailLabel",
    table: gmailLabels,
    selectRows: (db, mailAccountId, cursorRev) =>
      db
        .select()
        .from(gmailLabels)
        .where(
          and(eq(gmailLabels.mailAccountId, mailAccountId), gt(gmailLabels.syncRev, cursorRev)),
        )
        .orderBy(asc(gmailLabels.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireGmailLabel,
  }),
  mailAccountScopedCollection({
    name: "Composition",
    table: compositions,
    selectRows: (db, mailAccountId, cursorRev) =>
      db
        .select()
        .from(compositions)
        .where(
          and(eq(compositions.mailAccountId, mailAccountId), gt(compositions.syncRev, cursorRev)),
        )
        .orderBy(asc(compositions.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireComposition,
  }),
  mailAccountScopedCollection({
    name: "Correspondent",
    table: correspondents,
    selectRows: (db, mailAccountId, cursorRev) =>
      db
        .select()
        .from(correspondents)
        .where(
          and(
            eq(correspondents.mailAccountId, mailAccountId),
            gt(correspondents.syncRev, cursorRev),
          ),
        )
        .orderBy(asc(correspondents.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireCorrespondent,
  }),
];

/**
 * The two Connected-Account-scoped collections (#209) — `AddressBook`'s and
 * `Contact`'s own mirrored half, `userCollectionRegistry`'s Local half's
 * sibling. Both are empty for every Connected Account today: no upstream
 * adapter creates a mirrored Address Book yet (#214+ does), so this is
 * wiring proven correct ahead of a real user, the same posture
 * `scopeKind: "connectedAccount"` itself sat in for months before this
 * ticket.
 */
export const connectedAccountCollectionRegistry: readonly ConnectedAccountCollectionDescriptor<unknown>[] =
  [
    connectedAccountScopedCollection({
      name: "AddressBook",
      table: addressBooks,
      selectRows: (db, connectedAccountId, cursorRev) =>
        selectAddressBooksForConnectedAccount(db, connectedAccountId, cursorRev).limit(
          PAGE_SIZE + 1,
        ),
      toPayload: toWireAddressBook,
    }),
    connectedAccountScopedCollection({
      name: "Contact",
      table: contacts,
      selectRows: (db, connectedAccountId, cursorRev) =>
        selectContactsForConnectedAccount(db, connectedAccountId, cursorRev).limit(PAGE_SIZE + 1),
      toPayload: toWireContact,
    }),
  ];
