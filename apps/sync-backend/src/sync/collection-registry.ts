import type { CollectionDelta, EventDelta } from "@mail/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { computeEventWindow, toWireEvent } from "../calendars/event-store.js";
import { toWireRollback } from "../calendars/rollback-store.js";
import { ensurePersonalCalendar, toWireCalendar } from "../calendars/store.js";
import {
  selectConnectedAccountsForUser,
  toWireConnectedAccount,
} from "../connected-accounts/store.js";
import type { Db } from "../db/client.js";
import {
  calendars,
  compositions,
  connectedAccounts,
  correspondents,
  events,
  gmailLabels,
  labels,
  mailAccounts,
  notes,
  rollbacks,
  syncTombstones,
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
import {
  toWireComposition,
  toWireCorrespondent,
  toWireGmailLabel,
  toWireLabel,
  toWireNote,
  toWireThread,
} from "./thread-projection.js";

/**
 * The Sync Backend's collection registry (#184): every collection `POST
 * /sync` answers for is declared here once — its wire name, its Sync Scope,
 * and its row→wire projection — instead of a hand-written call list with a
 * branch per collection inside `routes/sync.ts`. That route iterates
 * `userCollectionRegistry`/`mailAccountCollectionRegistry` bucketed by which
 * scopes the request actually carries; nothing there names a collection by
 * hand any more. This is the prefactor ADR-0023's later App collections land
 * on: one declaration here, not six edits across six files.
 *
 * `connectedAccount` is declared as an accepted `ScopeKind` below with no
 * member yet — Calendar and Contacts (the Hub Apps) are its first real
 * users, not this ticket's.
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
interface DeclaredCollection {
  name: string;
  /** The row source this collection reads from. Tombstones, for every collection here, are the shared `syncTombstones` table filtered to `collection = name`. */
  table: AnyPgTable;
  toPayload: (row: never) => unknown;
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

export type CollectionDescriptor<Payload = unknown> =
  | UserCollectionDescriptor<Payload>
  | MailAccountCollectionDescriptor<Payload>;

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
 */
function userScopedCollection<Row extends SyncRevRow, Payload>(config: {
  name: string;
  table: AnyPgTable;
  selectRows: (db: Db, userId: string, cursorRev: number) => Promise<Row[]>;
  toPayload: (row: Row) => Payload;
}): UserCollectionDescriptor<Payload> {
  const { name, table, selectRows, toPayload } = config;
  return {
    name,
    scope: "user",
    table,
    toPayload: toPayload as (row: never) => Payload,
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
 * The eight User-scoped collections (ADR-0011, ADR-0025). `MailAccount` and
 * `Preference` are each a thin wrapper around `collection-sync.ts`'s own
 * hand-written query — see `userScopedCollection`'s doc comment for why
 * neither goes through it. `Label` (#186), `Note` (#192, ADR-0023),
 * `ConnectedAccount` (#200), `Calendar` and `Rollback` (#229) all do: each is
 * a plain `userId`-filtered table replicating whole. `Label` moved here from
 * `mailAccountCollectionRegistry` by changing exactly its declaration;
 * `Note` (#192) is this registry's first **new** member rather than a
 * migrated one — the same one-declaration shape either way, which is what
 * #184 built the registry for. `ConnectedAccount`'s own `selectRows` is the
 * one that isn't a one-line `db.select().from(...)` — it joins each account
 * to its own Facets (`connected-accounts/store.ts#selectConnectedAccountsForUser`),
 * the wire shape ADR-0022 asks for — but is otherwise exactly this same
 * shape. `Event` (#229) is the one windowed member — `userScopedCollection`
 * has no room for the window edges its delta carries alongside the ordinary
 * fields, so it is declared by hand below the array, the same "the registry
 * constrains declaration and dispatch, not query shape" line `Thread` sits
 * on the other side of.
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
  }),
  userScopedCollection({
    name: "ConnectedAccount",
    table: connectedAccounts,
    selectRows: (db, userId, cursorRev) =>
      selectConnectedAccountsForUser(db, userId, cursorRev).limit(PAGE_SIZE + 1),
    toPayload: toWireConnectedAccount,
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
