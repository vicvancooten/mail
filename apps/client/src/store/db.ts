import type {
  ComposeDocument,
  CompositionStatus,
  Label,
  MailAccount,
  MutationIntent,
  Recipient,
  Thread,
} from "@mail/shared";
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
export const CACHE_SCHEMA_VERSION = 4; // #46: `compositions` gains a `status` index for the Pending Send queries

export const DEFAULT_CACHE_NAME = "mail-local-cache";

/**
 * A cached Thread is the wire projection plus the derived ordering key the
 * `[mailAccountId+sortKey]` index needs. `sortKey` is cache bookkeeping, not
 * wire state — nothing outside `store/` should read it.
 */
export type CachedThread = Thread & { sortKey: string };

/**
 * Which list a window bounds. `all` is the one Sync Backend-fed window
 * (ADR-0009): the wire Thread carries no Folder, so there is exactly one
 * date-ordered list per Mail Account synced from `POST /sync`. A `label`
 * view (#43) is *not* a second synced window — the Sync Backend still only
 * ever serves the one Thread list — it is a client-side filter **over**
 * `all`'s already-bounded contents, by `Thread.labelIds`
 * (`store/reads.ts#readLabelView`). It still behaves like "a view, bounded
 * window like any other" from the User's perspective: it inherits `all`'s
 * floor and its `complete` flag, it just never gets its own `ListWindow` row
 * or state token, because there is nothing server-side to page through that
 * `all` hasn't already fetched. A future server-side label filter (once
 * search, ADR-0016, lands) would turn this into a real second window without
 * reshaping this type further.
 */
export type ViewKey = "all" | { readonly kind: "label"; readonly labelId: string };
export const DEFAULT_VIEW: ViewKey = "all";

function viewKeyPart(view: ViewKey): string {
  return view === "all" ? "all" : `label:${view.labelId}`;
}

export function listWindowKey(mailAccountId: string, view: ViewKey): string {
  return `${mailAccountId}|${viewKeyPart(view)}`;
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
 * A Composition (#45, ADR-0014): the Client's own durable copy, held from
 * the first keystroke — one row rather than a Thread's `base ⊕ pending`
 * overlay, because the two writers here own disjoint *fields* rather than
 * competing for the same ones (the composer owns the content, the Sync
 * Backend owns the send state), so there is nothing to merge at read time.
 * `store/compositions.ts` is both its component-facing read and write
 * surface, mirroring `cache-pins.ts`'s "one focused concern, one module"
 * shape rather than `reads.ts`/`mutation-queue.ts`'s split, which exists for
 * Threads to keep a "components never write a base row" line that has
 * nothing to enforce here.
 *
 * `version` is this Client's last-known server version — `0` before any
 * save has ever been acknowledged.
 *
 * From #46 the row is no longer *only* this Client's: the `Composition`
 * synced collection writes it too (`store/server-writes.ts`), which is what
 * makes a Pending Send's countdown visible on every device (ADR-0007).
 * `status`, `submitAfter`, `sendError` and `sentAt` are therefore
 * **server-owned** — a Client never predicts them, it waits for them, which
 * is ADR-0014's "the Undo Send countdown starts only when the Sync Backend
 * accepts it" expressed as a data rule. `sendState` is this Client's own
 * optimistic overlay for the gap in between (see below); the content fields
 * stay Client-owned while an autosave is still queued.
 */
export interface CachedComposition {
  id: string;
  mailAccountId: string;
  status: CompositionStatus;
  subject: string;
  document: ComposeDocument;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  version: number;
  /**
   * The absolute instant the Sync Backend will submit this Pending Send, as
   * it reported it. Null for a Draft — and null for a send this Client has
   * queued but the server has not accepted yet, which is exactly why
   * `sendState` exists rather than a locally-invented deadline.
   */
  submitAfter: string | null;
  /** The SMTP rejection verbatim, badging this Draft "Send failed" (compose-spec). */
  sendError: string | null;
  sentAt: string | null;
  /**
   * This Client's own view of a send it has queued but not yet had answered
   * (ADR-0010's overlay, in the one shape a Composition needs): `queued`
   * from the moment Send is pressed until the round trip lands, at which
   * point the server's `status` takes over and this goes back to `null`.
   * `too_late` records the one rejection the User must be told about — a
   * cancel that lost to the claim (ADR-0007).
   */
  sendState: "queued" | "cancelling" | "too_late" | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The coalescing autosave queue (ADR-0014's "single deliberate exception to
 * the FIFO, additive intent queue" — `store/mutation-queue.ts`'s own doc
 * comment). Keyed by `compositionId` rather than a fresh id per save, so a
 * `put()` from a later keystroke simply **overwrites** an still-unflushed
 * earlier one in place — coalescing is Dexie's own upsert semantics, no
 * cancellation logic needed. `saveId` is a fresh ULID minted on every
 * overwrite: the idempotency key `sync/compose-store.ts`'s ledger replays a
 * retry against, independent of the Composition's own `id`. Deliberately
 * carries no `version` of its own — `sync/sync-round.ts` reads the
 * Composition's *current* `version` fresh at flush time, so a save that
 * coalesced away an in-flight one is never sent against a version an
 * already-acknowledged sibling save has since advanced past.
 */
export interface PendingComposeSave {
  compositionId: string;
  mailAccountId: string;
  saveId: string;
  subject: string;
  document: ComposeDocument;
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  queuedAt: string;
}

/**
 * The durable Optimistic Action queue (ADR-0010, #39). Two of #38's cache
 * invariants are stated in terms of it: wipe-and-resync must never discard
 * a non-empty queue, and eviction must never drop a Thread a queued action
 * references (ADR-0009) — both read `referencedThreadIds` below.
 *
 * `intent` is not part of the Dexie index string (nothing queries by it),
 * so adding it did not need a `CACHE_SCHEMA_VERSION` bump — only a new
 * *indexed* field would.
 */
export interface PendingMutation {
  /** Client-generated ULID (`store/ulid.ts`), echoed by the Sync Backend as the idempotency key. */
  id: string;
  mailAccountId: string;
  createdAt: string;
  /** Threads this action is about — the eviction-exempt set, and what `reads.ts`'s overlay matches against. */
  referencedThreadIds: string[];
  /** The semantic intent itself (`store/mutation-queue.ts` is the only writer). */
  intent: MutationIntent;
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
  labels!: EntityTable<Label, "id">;
  listWindows!: EntityTable<ListWindow, "key">;
  cachePins!: EntityTable<CachePin, "threadId">;
  syncState!: EntityTable<SyncStateRow, "key">;
  pendingMutations!: EntityTable<PendingMutation, "id">;
  compositions!: EntityTable<CachedComposition, "id">;
  pendingComposeSaves!: EntityTable<PendingComposeSave, "compositionId">;
  cacheMeta!: EntityTable<CacheMetaRow, "key">;

  /** The value `ensureCacheSchema` compares the stored one against; overridable so tests can open the same database twice at different versions. */
  readonly schemaVersion: number;

  constructor(name: string = DEFAULT_CACHE_NAME, schemaVersion: number = CACHE_SCHEMA_VERSION) {
    super(name);
    this.schemaVersion = schemaVersion;
    this.version(schemaVersion).stores({
      mailAccounts: "id, createdAt",
      threads: "id, mailAccountId, [mailAccountId+sortKey]",
      labels: "id, mailAccountId",
      listWindows: "key, mailAccountId",
      cachePins: "threadId, mailAccountId",
      syncState: "key",
      pendingMutations: "id, mailAccountId, createdAt, *referencedThreadIds",
      compositions: "id, mailAccountId, status",
      pendingComposeSaves: "compositionId, mailAccountId",
      cacheMeta: "key",
    });
  }
}

/**
 * Everything a wipe clears. `cacheMeta`, `pendingMutations`, and
 * `pendingComposeSaves` are deliberately absent — the same "unsent user
 * intent survives" rule, extended to a queued autosave. `compositions`
 * itself *is* wiped: unlike `pendingMutations`, whose row carries no content
 * of its own, every `pendingComposeSaves` row is fully self-contained
 * (`db.ts#PendingComposeSave`'s own doc comment), so a wipe can never lose
 * content a queued save still protects, and a Composition with nothing
 * queued is by definition already server-confirmed at what this Client
 * last wrote — nothing left offline-only to lose.
 */
const DATA_TABLES = [
  "mailAccounts",
  "threads",
  "labels",
  "listWindows",
  "cachePins",
  "syncState",
  "compositions",
] as const;

export type CacheSchemaOutcome =
  /** No cache existed; this boot starts one. */
  | { status: "fresh" }
  /** The cache on disk already matches this build. */
  | { status: "current" }
  /** A schema bump discarded the cached mail; `sync` re-bootstraps it. */
  | { status: "wiped"; from: number | null }
  /**
   * A schema bump found unsent Optimistic Actions or queued Composition
   * autosaves. The old data stays and stays readable; the wipe retries once
   * both queues drain (ADR-0009: "flush first; if it cannot flush, the
   * upgrade waits" — ADR-0014 extends the same rule to autosave).
   */
  | {
      status: "deferred";
      from: number | null;
      pendingMutations: number;
      pendingComposeSaves: number;
    };

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
  const pendingComposeSaves = await db.pendingComposeSaves.count();
  if (pendingMutations > 0 || pendingComposeSaves > 0) {
    return { status: "deferred", from, pendingMutations, pendingComposeSaves };
  }

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
