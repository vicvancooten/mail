import type { CollectionDelta } from "@mail/shared";
import { and, asc, eq, gt } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { Db } from "../db/client.js";
import {
  compositions,
  correspondents,
  gmailLabels,
  labels,
  mailAccounts,
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
 * Declares one Mail-Account-scoped collection off its source table:
 * `Label`, `GmailLabel`, `Correspondent` and `Composition` all share the
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

/** `MailAccount` and `Preference` (ADR-0011): User-scoped, each a thin wrapper around `collection-sync.ts`'s own hand-written query — Preference matches this User's own `users` row by `id`, not a `mailAccountId` column, so it is not this file's `mailAccountScopedCollection` shape. */
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
];

/**
 * The seven collections `POST /sync` answers for, minus the two User-scoped
 * ones above. `Thread` keeps its own windowed query (`collection-sync.ts`)
 * rather than going through `mailAccountScopedCollection` — the registry
 * constrains declaration and dispatch, not query shape (#184).
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
    name: "Label",
    table: labels,
    selectRows: (db, mailAccountId, cursorRev) =>
      db
        .select()
        .from(labels)
        .where(and(eq(labels.mailAccountId, mailAccountId), gt(labels.syncRev, cursorRev)))
        .orderBy(asc(labels.syncRev))
        .limit(PAGE_SIZE + 1),
    toPayload: toWireLabel,
  }),
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
