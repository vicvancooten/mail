import type { MailAccount, Thread } from "@mail/shared";
import Dexie, { type EntityTable } from "dexie";

/**
 * The Local Cache's IndexedDB schema (ADR-0009). This is the only module in
 * the Client that declares tables; `store/` is the only module that touches
 * Dexie at all, and `sync/` reaches base rows exclusively through
 * `store/server-writes.ts` (ADR-0010's two-writer rule).
 *
 * The cache is **disposable by construction**: there are no hand-written
 * migrations for mail data. Bumping `CACHE_SCHEMA_VERSION` is the one knob —
 * it re-shapes the object stores *and* wipes their contents on the next
 * open, and the data comes back from `POST /sync`. The single absolute
 * exception is the pending Optimistic Action queue: unsent user intent is
 * never wiped, so a bump that finds a non-empty queue waits instead
 * (`ensureCacheSchema` → `deferred`).
 */

/**
 * Bump this for **any** change to the stores below, including a new index.
 * Doubles as the Dexie version number, so one bump is one wipe-and-resync.
 */
export const CACHE_SCHEMA_VERSION = 1;

export const DEFAULT_CACHE_NAME = "mail-local-cache";

/**
 * A cached Thread is the wire projection plus the derived ordering key the
 * `[mailAccountId+sortKey]` index needs. `sortKey` is cache bookkeeping, not
 * wire state — nothing outside `store/` should read it.
 */
export type CachedThread = Thread & { sortKey: string };

/**
 * Which list a window bounds. Only `all` exists today: the wire Thread
 * (`packages/shared/src/sync.ts`) carries no Folder or Label, so there is
 * exactly one date-ordered list per Mail Account to bound. The key keeps the
 * `(Mail Account, view)` shape ADR-0009 specifies so Inbox/Label windows are
 * an added value here rather than a reshape of the table.
 */
export type ViewKey = "all";
export const DEFAULT_VIEW: ViewKey = "all";

export function listWindowKey(mailAccountId: string, view: ViewKey): string {
  return `${mailAccountId}|${view}`;
}

/**
 * What the Client actually holds for one (Mail Account, view): contiguous
 * from newest, truncated at the bottom. Membership is a range rather than a
 * list of ids — every Thread of this Mail Account at or above
 * `oldestHeldSort`. There is therefore only ever one hole, at the bottom.
 */
export interface ListWindow {
  /** `listWindowKey(mailAccountId, view)`. */
  key: string;
  mailAccountId: string;
  view: ViewKey;
  /**
   * Oldest `sortKey` the window admits, or `null` while it has never been
   * trimmed and so admits everything the Sync Backend has offered it.
   */
  oldestHeldSort: string | null;
  /**
   * False once the bottom has been truncated: older mail exists that the
   * Client does not hold, and the list must say so rather than ending
   * silently.
   */
  complete: boolean;
}

/** A Thread the User opened: kept in the entity cache regardless of age (ADR-0009). */
export interface CachePin {
  threadId: string;
  mailAccountId: string;
  pinnedAt: string;
}

/**
 * One collection's opaque state token (ADR-0011). Keyed
 * `user:MailAccount` / `account:<id>:Thread`. Written only inside the same
 * transaction as the rows it accounts for, so a crash mid-round can never
 * advance a token past data that didn't land.
 */
export interface SyncStateRow {
  key: string;
  token: string;
}

/**
 * The durable Optimistic Action queue. **#39 owns this table's contents and
 * the `base ⊕ pending` overlay**; it is declared here, empty, because two of
 * this ticket's invariants are stated in terms of it: wipe-and-resync must
 * never discard a non-empty queue, and eviction must never drop a Thread a
 * queued action references (ADR-0009). #39 adds the intent payload as new
 * fields on this row.
 */
export interface PendingMutation {
  /** Client-generated ULID, echoed by the Sync Backend as the idempotency key. */
  id: string;
  mailAccountId: string;
  createdAt: string;
  /** Threads this action is about — the eviction-exempt set. */
  referencedThreadIds: string[];
}

/** Cache-level bookkeeping that survives a wipe (it is what records that one happened). */
export interface CacheMetaRow {
  key: string;
  value: number;
}

export const SCHEMA_VERSION_META_KEY = "schemaVersion";

export class LocalCache extends Dexie {
  mailAccounts!: EntityTable<MailAccount, "id">;
  threads!: EntityTable<CachedThread, "id">;
  listWindows!: EntityTable<ListWindow, "key">;
  cachePins!: EntityTable<CachePin, "threadId">;
  syncState!: EntityTable<SyncStateRow, "key">;
  pendingMutations!: EntityTable<PendingMutation, "id">;
  cacheMeta!: EntityTable<CacheMetaRow, "key">;

  /** The value `ensureCacheSchema` compares the stored one against; overridable so tests can open the same database twice at different versions. */
  readonly schemaVersion: number;

  constructor(name: string = DEFAULT_CACHE_NAME, schemaVersion: number = CACHE_SCHEMA_VERSION) {
    super(name);
    this.schemaVersion = schemaVersion;
    this.version(schemaVersion).stores({
      mailAccounts: "id, createdAt",
      threads: "id, mailAccountId, [mailAccountId+sortKey]",
      listWindows: "key, mailAccountId",
      cachePins: "threadId, mailAccountId",
      syncState: "key",
      pendingMutations: "id, mailAccountId, createdAt, *referencedThreadIds",
      cacheMeta: "key",
    });
  }
}

/** Everything a wipe clears. `cacheMeta` and `pendingMutations` are deliberately absent. */
const DATA_TABLES = ["mailAccounts", "threads", "listWindows", "cachePins", "syncState"] as const;

export type CacheSchemaOutcome =
  /** No cache existed; this boot starts one. */
  | { status: "fresh" }
  /** The cache on disk already matches this build. */
  | { status: "current" }
  /** A schema bump discarded the cached mail; `sync` re-bootstraps it. */
  | { status: "wiped"; from: number | null }
  /**
   * A schema bump found unsent Optimistic Actions. The old data stays and
   * stays readable; the wipe retries once the queue drains (ADR-0009:
   * "flush first; if it cannot flush, the upgrade waits").
   */
  | { status: "deferred"; from: number | null; pendingMutations: number };

/**
 * Reconciles the cache on disk with this build's schema. Called on every
 * open and again before every sync round, so a `deferred` wipe happens the
 * moment #39's queue flush drains.
 */
export async function ensureCacheSchema(db: LocalCache): Promise<CacheSchemaOutcome> {
  const stored = await db.cacheMeta.get(SCHEMA_VERSION_META_KEY);
  if (stored?.value === db.schemaVersion) return { status: "current" };

  const from = stored?.value ?? null;
  if (from === null && (await isEmpty(db))) {
    await db.cacheMeta.put({ key: SCHEMA_VERSION_META_KEY, value: db.schemaVersion });
    return { status: "fresh" };
  }

  const pendingMutations = await db.pendingMutations.count();
  if (pendingMutations > 0) return { status: "deferred", from, pendingMutations };

  await db.transaction(
    "rw",
    DATA_TABLES.map((table) => db.table(table)),
    async () => {
      for (const table of DATA_TABLES) await db.table(table).clear();
    },
  );
  await db.cacheMeta.put({ key: SCHEMA_VERSION_META_KEY, value: db.schemaVersion });
  return { status: "wiped", from };
}

async function isEmpty(db: LocalCache): Promise<boolean> {
  for (const table of DATA_TABLES) {
    if ((await db.table(table).count()) > 0) return false;
  }
  return true;
}
