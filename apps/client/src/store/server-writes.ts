import type {
  AddressBook,
  Calendar,
  CollectionDelta,
  Composition,
  ConnectedAccount,
  Contact,
  ContactLink,
  ContactRollback,
  Correspondent,
  EventDelta,
  GmailLabel,
  Label,
  MailAccount,
  Note,
  Preference,
  Rollback,
  Task,
  TaskList,
  Thread,
} from "@mail/shared";
import Dexie from "dexie";
import { notifyContactRollback } from "../contacts/contact-rollback-toast.js";
import { closeStaleThreadNotification } from "../pwa/close-stale-notifications.js";
import {
  type CachedComposition,
  type CachedThread,
  DEFAULT_VIEW,
  type ListWindow,
  type LocalCache,
  listWindowKey,
  type ViewKey,
} from "./db.js";
import { localCache } from "./local-cache.js";
import { threadSortKey } from "./thread-sort-key.js";

/**
 * The base-row writer. **`sync/` is the only caller** (ADR-0010): components
 * read through `store/reads.ts` and write through the Optimistic Action
 * queue, and neither ever sees a Dexie table or a state token. Everything
 * here is a translation of one `POST /sync` collection delta into the
 * bounded working set ADR-0009 specifies, in a single transaction with the
 * state token it accounts for — so a round that dies mid-write can never
 * leave a token pointing past data that didn't land.
 */

/** ADR-0009's guaranteed floor: the newest ~500 Threads per view per Mail Account, always held. */
export const THREAD_WINDOW_FLOOR = 500;

/**
 * Trim only once a window has grown to twice its floor. The gap is what
 * stops a bootstrap from re-trimming on every page: at the Sync Backend's
 * 500-entity page size, this trims at most once per page and usually far
 * less, because once a cutoff exists the older pages are ignored outright.
 */
export const THREAD_WINDOW_HIGH_WATER = 2 * THREAD_WINDOW_FLOOR;

export const MAIL_ACCOUNT_TOKEN_KEY = "user:MailAccount";
export const PREFERENCE_TOKEN_KEY = "user:Preference";
/** `Label` is User-scoped since #186, so its token is keyed like `Preference`'s, not per Mail Account. */
export const LABEL_TOKEN_KEY = "user:Label";
/** `Note` (#192, ADR-0023): User-scoped from the start, so its token is keyed like `Label`'s. */
export const NOTE_TOKEN_KEY = "user:Note";
/** `TaskList` (#251, ADR-0030): User-scoped from the start, `Note`'s own shape. */
export const TASK_LIST_TOKEN_KEY = "user:TaskList";
/** `Task` (#251, ADR-0030): User-scoped from the start, `Note`'s own shape. */
export const TASK_TOKEN_KEY = "user:Task";
/** `ConnectedAccount` (#199, #200, ADR-0022): User-scoped from the start, so its token is keyed like `Note`'s. */
export const CONNECTED_ACCOUNT_TOKEN_KEY = "user:ConnectedAccount";
/** `AddressBook` (#209, ADR-0023): the Local Address Book's own slot — a mirrored book's own token is `connectedAccountAddressBookTokenKey` below. */
export const ADDRESS_BOOK_TOKEN_KEY = "user:AddressBook";
/** `Contact` (#209, ADR-0023): `AddressBook`'s sibling — Local Contacts only. */
export const CONTACT_TOKEN_KEY = "user:Contact";
/** `ContactRollback` (#216): `Contact`'s sibling — see `@mail/shared#contactRollbackSchema`'s own doc comment. */
export const CONTACT_ROLLBACK_TOKEN_KEY = "user:ContactRollback";
/** `Calendar` (#229): User-scoped from the start, so its token is keyed like `Note`'s. */
export const CALENDAR_TOKEN_KEY = "user:Calendar";
/** `Event` (#229): User-scoped on this line — see `collection-registry.ts`'s own doc comment on the deferred `connectedAccount` scope. */
export const EVENT_TOKEN_KEY = "user:Event";
/** `Rollback` (#229, ADR-0025): User-scoped, `Calendar`'s sibling. */
export const ROLLBACK_TOKEN_KEY = "user:Rollback";

export function threadTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:Thread`;
}

export function gmailLabelTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:GmailLabel`;
}

export function compositionTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:Composition`;
}

export function correspondentTokenKey(mailAccountId: string): string {
  return `account:${mailAccountId}:Correspondent`;
}

/** `AddressBook` (#209), scoped to one Connected Account — a mirrored book's own token, `threadTokenKey`'s sibling under the `connectedAccount:` prefix rather than `account:` (which already names a Mail Account). */
export function connectedAccountAddressBookTokenKey(connectedAccountId: string): string {
  return `connectedAccount:${connectedAccountId}:AddressBook`;
}

/** `ContactLink` (#222, ADR-0026): User-scoped only — a link spans Origins by construction and so has no Connected-Account-scoped sibling at all, unlike the two keys above. */
export const CONTACT_LINK_TOKEN_KEY = "user:ContactLink";

/** `Contact` (#209), scoped to one Connected Account — `connectedAccountAddressBookTokenKey`'s sibling. */
export function connectedAccountContactTokenKey(connectedAccountId: string): string {
  return `connectedAccount:${connectedAccountId}:Contact`;
}

export async function getSyncToken(key: string): Promise<string | null> {
  const row = await localCache().syncState.get(key);
  return row?.token ?? null;
}

/** Which Mail Accounts this Client asks for Thread deltas about: the ones it holds. */
export async function listCachedMailAccountIds(): Promise<string[]> {
  return localCache().mailAccounts.toCollection().primaryKeys();
}

/** Which Connected Accounts this Client asks for `AddressBook`/`Contact` deltas about (#209): the ones it holds — `listCachedMailAccountIds`' sibling. */
export async function listCachedConnectedAccountIds(): Promise<string[]> {
  return localCache().connectedAccounts.toCollection().primaryKeys();
}

export interface ApplyDeltaOptions {
  /**
   * True on the **first page of a `reset: true` replay** (ADR-0011): the
   * Client discards what it had for this collection before merging. Later
   * pages of the same replay carry `reset` too but must not clear again,
   * which is why this is the caller's call and not `delta.reset`.
   */
  replace: boolean;
}

/** `MailAccount`, User-scoped. Destroying one cascades to everything keyed by it. */
export async function applyMailAccountDelta(
  delta: CollectionDelta<MailAccount>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction(
    "rw",
    [
      db.mailAccounts,
      db.threads,
      db.gmailLabels,
      db.correspondents,
      db.compositions,
      db.listWindows,
      db.cachePins,
      db.syncState,
    ],
    async () => {
      if (replace) await db.mailAccounts.clear();
      await db.mailAccounts.bulkPut([...delta.created, ...delta.updated]);
      await deleteMailAccountData(db, delta.destroyed);
      await db.syncState.put({ key: MAIL_ACCOUNT_TOKEN_KEY, token: delta.newState });
    },
  );
}

/**
 * `Preference`, User-scoped (#54): exactly one row, so unlike every other
 * collection here there is no `mailAccountId` and nothing to bulk-delete —
 * `bulkPut` on a one-row page is simply "replace this Client's copy of the
 * User's own settings".
 */
export async function applyPreferenceDelta(
  delta: CollectionDelta<Preference>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.preferences, db.syncState], async () => {
    if (replace) await db.preferences.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.preferences.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.preferences.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: PREFERENCE_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `Thread`, scoped to one Mail Account. This is where the working set is
 * bounded: a Thread below the window's cutoff that the Client has never held
 * is **ignored, never auto-fetched**, and a window grown past its high water
 * is trimmed back to the floor.
 */
export async function applyThreadDelta(
  mailAccountId: string,
  delta: CollectionDelta<Thread>,
  { replace }: ApplyDeltaOptions,
  view: ViewKey = DEFAULT_VIEW,
): Promise<void> {
  const db = localCache();
  await db.transaction(
    "rw",
    [db.threads, db.listWindows, db.cachePins, db.pendingMutations, db.syncState],
    async () => {
      let window = await loadWindow(db, mailAccountId, view);
      if (replace) {
        await db.threads.where("mailAccountId").equals(mailAccountId).delete();
        window = { ...window, oldestHeldSort: null, complete: true };
        await db.listWindows.put(window);
      }

      const upserts = [...delta.created, ...delta.updated];
      if (upserts.length > 0) {
        const pinned = await pinnedThreadIds(db, mailAccountId);
        const known = new Set(
          await db.threads
            .where("id")
            .anyOf(upserts.map((thread) => thread.id))
            .primaryKeys(),
        );
        const admitted: CachedThread[] = [];
        for (const thread of upserts) {
          const sortKey = threadSortKey(thread);
          // An already-held Thread is always re-written, even if its date
          // moved below the cutoff: leaving the stale row behind would show
          // the User an outdated list row until the next trim.
          const inWindow = window.oldestHeldSort === null || sortKey >= window.oldestHeldSort;
          if (inWindow || known.has(thread.id) || pinned.has(thread.id)) {
            admitted.push({ ...thread, sortKey });
          }
        }
        await db.threads.bulkPut(admitted);
      }

      if (delta.destroyed.length > 0) {
        await db.threads.bulkDelete(delta.destroyed);
        await db.cachePins.bulkDelete(delta.destroyed);
      }

      await db.syncState.put({ key: threadTokenKey(mailAccountId), token: delta.newState });
    },
  );
  // Outside the transaction, and not run inline: ADR-0009 asks for eviction
  // to run on idle, not on this write path. `scheduleWindowTrim` only
  // records that this window may be over its high water and coalesces the
  // actual sweep onto the next idle tick — see its own doc comment.
  scheduleWindowTrim(mailAccountId, view);

  // "Any delta marking the thread `\Seen` lets the service worker close
  // stale notifications on other devices" (#53, ADR-0015). Only
  // `delta.updated` — a `created` row can only mean a backfill/replace
  // Thread this device has never seen before, which never had a
  // notification to begin with. Best-effort, outside the transaction, and
  // never awaited: this is cosmetic cleanup, not part of the write this
  // function promises.
  for (const thread of delta.updated) {
    if (thread.unreadCount === 0) void closeStaleThreadNotification(thread.id);
  }
}

/**
 * `Label`, User-scoped (#43, ADR-0011; #186, ADR-0023). One set spanning
 * every Mail Account, so a `replace` clears the whole table rather than one
 * account's rows. No windowing — unlike `Thread` there is no bounded working
 * set to maintain, a User has at most a handful of Labels at PoC scope (no
 * management UI to make many of them), so every Label they have is simply
 * held in full.
 */
export async function applyLabelDelta(
  delta: CollectionDelta<Label>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.labels, db.syncState], async () => {
    if (replace) await db.labels.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.labels.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.labels.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: LABEL_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `Note` (#192, ADR-0023). `Label`'s sibling above for the whole-replication
 * shape, but — like `Composition` below — the only *other* delta with a
 * merge rule: a Note with an unflushed `pendingNoteSaves` row holds a
 * `document` the server has not seen, and taking the wire's older copy would
 * destroy exactly what the `documentSaves` channel exists to protect. Once the
 * save lands there is no queued row and the server's copy is simply
 * adopted, which is also how the *other* device's edit shows up here once
 * this one has nothing outstanding of its own.
 */
export async function applyNoteDelta(
  delta: CollectionDelta<Note>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.notes, db.pendingNoteSaves, db.syncState], async () => {
    if (replace) await db.notes.clear();

    for (const wire of [...delta.created, ...delta.updated]) {
      const hasUnflushedEdit = (await db.pendingNoteSaves.get(wire.id)) !== undefined;
      const local = await db.notes.get(wire.id);
      await db.notes.put(hasUnflushedEdit && local ? { ...wire, document: local.document } : wire);
    }

    if (delta.destroyed.length > 0) {
      await db.notes.bulkDelete(delta.destroyed);
      await db.pendingNoteSaves.bulkDelete(delta.destroyed);
    }
    await db.syncState.put({ key: NOTE_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `TaskList` (#251, ADR-0030). No merge rule of its own — unlike `Note`/`Task`
 * a List's own body is `sections`, a plain structural field, never something
 * a `documentSaves`-style queued save could hold a newer copy of, so a plain
 * `bulkPut` is the whole of "adopt whatever the wire says" here.
 */
export async function applyTaskListDelta(
  delta: CollectionDelta<TaskList>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.taskLists, db.syncState], async () => {
    if (replace) await db.taskLists.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.taskLists.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.taskLists.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: TASK_LIST_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `ConnectedAccount` (#199, #200, ADR-0022). `Label`'s sibling above: whole-
 * replicated, no windowing, no per-Mail-Account split — every Connected
 * Account a User holds is simply held in full, the same "a handful of rows
 * every surface wants to label things with" reasoning the ticket itself
 * gives. No merge rule: unlike `Note`, nothing here is ever edited locally
 * ahead of the server (there is no Optimistic Action that writes a Connected
 * Account), so the wire's copy is always adopted as-is.
 */
export async function applyConnectedAccountDelta(
  delta: CollectionDelta<ConnectedAccount>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.connectedAccounts, db.syncState], async () => {
    if (replace) await db.connectedAccounts.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.connectedAccounts.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.connectedAccounts.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: CONNECTED_ACCOUNT_TOKEN_KEY, token: delta.newState });
  });
}

/** Every Address Book id currently held whose `origin` matches — `db.addressBooks` is one flat table across every scope (`db.ts`'s own doc comment), so a scoped `replace` clear reads it with a plain filter rather than an index. Small collection, same reasoning `notes`/`connectedAccounts` accept elsewhere. */
async function addressBookIdsWhere(
  db: LocalCache,
  predicate: (book: AddressBook) => boolean,
): Promise<string[]> {
  return (await db.addressBooks.toArray()).filter(predicate).map((book) => book.id);
}

/**
 * `AddressBook` (#209, ADR-0023, ADR-0026), the Local Address Book's own
 * slot — `applyConnectedAccountAddressBookDelta` below is this same shape
 * for a mirrored one. No merge rule, `ConnectedAccount`'s own sibling:
 * nothing writes an Address Book locally ahead of the server yet (no
 * Contacts App, no adapter, #210+).
 */
export async function applyAddressBookDelta(
  delta: CollectionDelta<AddressBook>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.addressBooks, db.syncState], async () => {
    if (replace) {
      const localIds = await addressBookIdsWhere(db, (book) => book.origin.kind === "local");
      if (localIds.length > 0) await db.addressBooks.bulkDelete(localIds);
    }
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.addressBooks.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.addressBooks.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: ADDRESS_BOOK_TOKEN_KEY, token: delta.newState });
  });
}

/** `AddressBook`, scoped to one Connected Account (#209) — `applyAddressBookDelta`'s sibling for a mirrored book, the `GmailLabel`-style per-scope `replace` shape applied to a shared table instead of a dedicated one. */
export async function applyConnectedAccountAddressBookDelta(
  connectedAccountId: string,
  delta: CollectionDelta<AddressBook>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.addressBooks, db.syncState], async () => {
    if (replace) {
      const ids = await addressBookIdsWhere(
        db,
        (book) =>
          book.origin.kind === "connectedAccount" &&
          book.origin.connectedAccountId === connectedAccountId,
      );
      if (ids.length > 0) await db.addressBooks.bulkDelete(ids);
    }
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.addressBooks.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.addressBooks.bulkDelete(delta.destroyed);
    await db.syncState.put({
      key: connectedAccountAddressBookTokenKey(connectedAccountId),
      token: delta.newState,
    });
  });
}

/**
 * `Contact` (#209, ADR-0023, ADR-0026), the Local slot — deliberately
 * minimal, `contacts.ts#contactSchema`'s own doc comment. A Contact carries
 * no `origin`/`userId` of its own (CONTEXT.md: "takes the Origin of its
 * collection"), so a scoped `replace` clear has to resolve which Address
 * Books are Local first, off `db.addressBooks` (already applied earlier in
 * the same sync round — `USER_COLLECTIONS`' own declared order,
 * `collection-registry.ts`).
 */
export async function applyContactDelta(
  delta: CollectionDelta<Contact>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.addressBooks, db.contacts, db.syncState], async () => {
    if (replace) {
      const localBookIds = new Set(
        await addressBookIdsWhere(db, (book) => book.origin.kind === "local"),
      );
      const localContactIds = (await db.contacts.toArray())
        .filter((contact) => localBookIds.has(contact.addressBookId))
        .map((contact) => contact.id);
      if (localContactIds.length > 0) await db.contacts.bulkDelete(localContactIds);
    }
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.contacts.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.contacts.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: CONTACT_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `ContactRollback` (#216), User-scoped, append-only — `Label`'s
 * whole-replication shape (`applyLabelDelta`), plus one thing no other
 * collection here does: it also raises the toast
 * (`contacts/contact-rollback-toast.ts#notifyContactRollback`) for every
 * row genuinely new in this round.
 *
 * `!replace` gates that: `replace` is true only on the first page of a
 * bootstrap/reset replay (`ApplyDeltaOptions`'s own doc comment), whose
 * `delta.created` is this User's *entire* rollback history rather than
 * "what happened since the last time this Client asked" — a fresh install,
 * or a `CACHE_SCHEMA_VERSION` wipe, must not replay every rollback that ever
 * happened as a fresh burst of toasts.
 */
export async function applyContactRollbackDelta(
  delta: CollectionDelta<ContactRollback>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.contactRollbacks, db.syncState], async () => {
    if (replace) await db.contactRollbacks.clear();
    if (delta.created.length > 0) await db.contactRollbacks.bulkPut(delta.created);
    await db.syncState.put({ key: CONTACT_ROLLBACK_TOKEN_KEY, token: delta.newState });
  });
  if (!replace) {
    for (const rollback of delta.created) notifyContactRollback(rollback);
  }
}

/** `Contact`, scoped to one Connected Account (#209) — `applyContactDelta`'s sibling for a mirrored Address Book's Contacts. */
export async function applyConnectedAccountContactDelta(
  connectedAccountId: string,
  delta: CollectionDelta<Contact>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.addressBooks, db.contacts, db.syncState], async () => {
    if (replace) {
      const bookIds = new Set(
        await addressBookIdsWhere(
          db,
          (book) =>
            book.origin.kind === "connectedAccount" &&
            book.origin.connectedAccountId === connectedAccountId,
        ),
      );
      const contactIds = (await db.contacts.toArray())
        .filter((contact) => bookIds.has(contact.addressBookId))
        .map((contact) => contact.id);
      if (contactIds.length > 0) await db.contacts.bulkDelete(contactIds);
    }
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.contacts.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.contacts.bulkDelete(delta.destroyed);
    await db.syncState.put({
      key: connectedAccountContactTokenKey(connectedAccountId),
      token: delta.newState,
    });
  });
}

/**
 * `ContactLink` (#222, ADR-0026), User-scoped and whole — `applyNoteDelta`'s
 * own no-merge shape rather than either Contact applier's above: a link has
 * no per-scope `replace` clear to resolve, because there is only one scope
 * it can belong to.
 *
 * Deliberately does **not** drop a link whose members this Client no longer
 * holds (an unmirrored book's Contacts, a Contact deleted on another
 * device): the Sync Backend prunes the link itself
 * (`contacts/link-store.ts#pruneContactLinkMembers`) and sends the real
 * update or tombstone, and until it arrives every reader already tolerates a
 * member id it can't resolve (`@mail/shared#resolveLinkedContactGroups`).
 * Second-guessing that here would mean this Client inventing an unlink the
 * User never performed.
 */
export async function applyContactLinkDelta(
  delta: CollectionDelta<ContactLink>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.contactLinks, db.syncState], async () => {
    if (replace) await db.contactLinks.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.contactLinks.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.contactLinks.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: CONTACT_LINK_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `Task` (#251, ADR-0030). `applyNoteDelta`'s exact merge rule: a Task with
 * an unflushed `pendingTaskSaves` row holds a `document` the server hasn't
 * seen yet, so its wire copy is adopted everywhere except that one field.
 */
export async function applyTaskDelta(
  delta: CollectionDelta<Task>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.tasks, db.pendingTaskSaves, db.syncState], async () => {
    if (replace) await db.tasks.clear();

    for (const wire of [...delta.created, ...delta.updated]) {
      const hasUnflushedEdit = (await db.pendingTaskSaves.get(wire.id)) !== undefined;
      const local = await db.tasks.get(wire.id);
      await db.tasks.put(hasUnflushedEdit && local ? { ...wire, document: local.document } : wire);
    }

    if (delta.destroyed.length > 0) {
      await db.tasks.bulkDelete(delta.destroyed);
      await db.pendingTaskSaves.bulkDelete(delta.destroyed);
    }
    await db.syncState.put({ key: TASK_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `Calendar` (#229). `Label`'s whole-replication shape exactly — a User has
 * at most a handful of Calendars, same as Labels at PoC scope.
 */
export async function applyCalendarDelta(
  delta: CollectionDelta<Calendar>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.calendars, db.syncState], async () => {
    if (replace) await db.calendars.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.calendars.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.calendars.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: CALENDAR_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `Event` (#229): always empty on this line (no materialiser yet, #230), so
 * this is `applyCalendarDelta`'s shape plus persisting the two Event Window
 * edges the delta carries alongside the ordinary fields — the honest
 * "what the Sync Backend has bounded this to" `ListWindow` already keeps for
 * Thread, computed server-side here rather than trimmed client-side.
 */
export async function applyEventDelta(
  delta: EventDelta,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.events, db.eventWindows, db.syncState], async () => {
    if (replace) await db.events.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.events.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.events.bulkDelete(delta.destroyed);
    await db.eventWindows.put({ key: "current", start: delta.windowStart, end: delta.windowEnd });
    await db.syncState.put({ key: EVENT_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `Rollback` (#229, ADR-0025): `Calendar`'s sibling — always empty until
 * #237's write-back produces a row.
 */
export async function applyRollbackDelta(
  delta: CollectionDelta<Rollback>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.rollbacks, db.syncState], async () => {
    if (replace) await db.rollbacks.clear();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.rollbacks.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.rollbacks.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: ROLLBACK_TOKEN_KEY, token: delta.newState });
  });
}

/**
 * `GmailLabel`, scoped to one Mail Account (#126, ADR-0020). `Label`'s
 * sibling above, same no-windowing shape, into its own table — never merged
 * into `db.labels`, a Gmail Label is never a Wicket Label (CONTEXT.md).
 */
export async function applyGmailLabelDelta(
  mailAccountId: string,
  delta: CollectionDelta<GmailLabel>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.gmailLabels, db.syncState], async () => {
    if (replace) await db.gmailLabels.where("mailAccountId").equals(mailAccountId).delete();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.gmailLabels.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.gmailLabels.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: gmailLabelTokenKey(mailAccountId), token: delta.newState });
  });
}

/**
 * `Correspondent`, scoped to one Mail Account (#49, compose-spec §Recipient
 * autocomplete). No windowing, the same as `Label`: the Sync Backend never
 * hands this Client more than the top ~500 by score in the first place
 * (`sync/correspondents.ts#capCorrespondents`), so "hold everything this
 * collection sends" already *is* "hold the top ~500" — there is nothing left
 * for the Client to trim.
 */
export async function applyCorrespondentDelta(
  mailAccountId: string,
  delta: CollectionDelta<Correspondent>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.correspondents, db.syncState], async () => {
    if (replace) await db.correspondents.where("mailAccountId").equals(mailAccountId).delete();
    const upserts = [...delta.created, ...delta.updated];
    if (upserts.length > 0) await db.correspondents.bulkPut(upserts);
    if (delta.destroyed.length > 0) await db.correspondents.bulkDelete(delta.destroyed);
    await db.syncState.put({ key: correspondentTokenKey(mailAccountId), token: delta.newState });
  });
}

/**
 * `Composition`, scoped to one Mail Account (#46). The only delta whose rows
 * this Client also writes itself, so it is the only one with a merge rule:
 *
 * - **Send state is always the server's.** `status`, `submitAfter`,
 *   `sendError` and `sentAt` are overwritten unconditionally — that is the
 *   whole mechanism by which a Pending Send started on one device shows its
 *   countdown on another (ADR-0007).
 * - **Content is the Client's while a save is still queued.** A Composition
 *   with an unflushed `pendingComposeSaves` row holds text the server has not
 *   seen; taking the server's older copy would destroy exactly what ADR-0012
 *   says is worth code to prevent. Once the save lands there is no queued row
 *   and the server's copy is simply adopted, which is also how a cancel on
 *   another device hands this one the content to reopen the composer with.
 * - **`sendState` is cleared by any terminal server status,** so a marker
 *   left behind by a round trip this tab never saw the answer to cannot
 *   outlive the send it described.
 */
export async function applyCompositionDelta(
  mailAccountId: string,
  delta: CollectionDelta<Composition>,
  { replace }: ApplyDeltaOptions,
): Promise<void> {
  const db = localCache();
  await db.transaction("rw", [db.compositions, db.pendingComposeSaves, db.syncState], async () => {
    if (replace) await db.compositions.where("mailAccountId").equals(mailAccountId).delete();

    for (const wire of [...delta.created, ...delta.updated]) {
      const local = await db.compositions.get(wire.id);
      const hasUnflushedEdit = (await db.pendingComposeSaves.get(wire.id)) !== undefined;
      await db.compositions.put(mergeComposition(wire, local, hasUnflushedEdit));
    }

    if (delta.destroyed.length > 0) {
      await db.compositions.bulkDelete(delta.destroyed);
      await db.pendingComposeSaves.bulkDelete(delta.destroyed);
    }
    await db.syncState.put({
      key: compositionTokenKey(mailAccountId),
      token: delta.newState,
    });
  });
}

function mergeComposition(
  wire: Composition,
  local: CachedComposition | undefined,
  hasUnflushedEdit: boolean,
): CachedComposition {
  const content =
    local && hasUnflushedEdit
      ? {
          subject: local.subject,
          document: local.document,
          to: local.to,
          cc: local.cc,
          bcc: local.bcc,
          inReplyTo: local.inReplyTo,
          references: local.references,
        }
      : {
          subject: wire.subject,
          document: wire.document,
          to: wire.to,
          cc: wire.cc,
          bcc: wire.bcc,
          inReplyTo: wire.inReplyTo,
          references: wire.references,
        };
  return {
    id: wire.id,
    mailAccountId: wire.mailAccountId,
    status: wire.status,
    ...content,
    version: wire.version,
    submitAfter: wire.submitAfter,
    sendError: wire.sendError,
    sentAt: wire.sentAt,
    // #101: `discarded` joins `draft`/`sent` here for the same reason —
    // neither status can ever follow a live `pending`/`submitting` send
    // without passing back through `draft` first (Discard only ever accepts
    // a `draft` row), so this is defensive rather than reachable today.
    sendState:
      wire.status === "draft" || wire.status === "sent" || wire.status === "discarded"
        ? null
        : (local?.sendState ?? null),
    createdAt: local?.createdAt ?? wire.updatedAt,
    updatedAt: wire.updatedAt,
    // Server-owned, always — an attach/delete already lands optimistically
    // via `store/attachments.ts`'s own direct write the moment its HTTP call
    // resolves; this delta is simply the authoritative confirmation.
    attachments: wire.attachments,
  };
}

/**
 * Drops everything keyed to a Mail Account the User no longer has. Runs at
 * the end of a sync round rather than on the delta, because a `reset: true`
 * MailAccount replay only reveals what is gone once its last page lands.
 * A no-op until the MailAccount collection has bootstrapped at least once —
 * before that, an empty table means "not synced yet", not "no accounts".
 */
export async function pruneOrphanedMailAccountData(): Promise<void> {
  const db = localCache();
  if ((await getSyncToken(MAIL_ACCOUNT_TOKEN_KEY)) === null) return;

  await db.transaction(
    "rw",
    [
      db.mailAccounts,
      db.threads,
      db.gmailLabels,
      db.correspondents,
      db.compositions,
      db.listWindows,
      db.cachePins,
      db.syncState,
    ],
    async () => {
      const live = new Set(await db.mailAccounts.toCollection().primaryKeys());
      const held = new Set<string>();
      for (const window of await db.listWindows.toArray()) held.add(window.mailAccountId);
      for (const id of await db.threads.orderBy("mailAccountId").uniqueKeys()) {
        held.add(String(id));
      }
      const orphaned = [...held].filter((id) => !live.has(id));
      if (orphaned.length > 0) await deleteMailAccountData(db, orphaned);
    },
  );
}

async function deleteMailAccountData(db: LocalCache, mailAccountIds: string[]): Promise<void> {
  if (mailAccountIds.length === 0) return;
  await db.mailAccounts.bulkDelete(mailAccountIds);
  await db.threads.where("mailAccountId").anyOf(mailAccountIds).delete();
  // `labels` is deliberately absent: a Label belongs to the User, not to any
  // one Mail Account (#186), so removing an account leaves the Label set
  // whole — only the `labelIds` of the Threads going away with it disappear.
  await db.gmailLabels.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.correspondents.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.compositions.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.listWindows.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.cachePins.where("mailAccountId").anyOf(mailAccountIds).delete();
  await db.syncState.bulkDelete([
    ...mailAccountIds.map(threadTokenKey),
    ...mailAccountIds.map(gmailLabelTokenKey),
    ...mailAccountIds.map(correspondentTokenKey),
    ...mailAccountIds.map(compositionTokenKey),
  ]);
}

/**
 * Drops a mirrored Address Book (and, cascading, its Contacts) whose
 * Connected Account is gone — `pruneOrphanedMailAccountData`'s own sibling
 * for #209's collections, same "runs at the end of a round, off the table a
 * `reset: true` replay has already finished writing" reasoning. The Local
 * Address Book is never orphaned this way: it has no Connected Account to
 * lose. A no-op until `ConnectedAccount` has bootstrapped at least once —
 * before that, an empty table means "not synced yet", not "no accounts".
 */
export async function pruneOrphanedAddressBookData(): Promise<void> {
  const db = localCache();
  if ((await getSyncToken(CONNECTED_ACCOUNT_TOKEN_KEY)) === null) return;

  await db.transaction(
    "rw",
    [db.connectedAccounts, db.addressBooks, db.contacts, db.syncState],
    async () => {
      const liveConnectedAccountIds = new Set(
        await db.connectedAccounts.toCollection().primaryKeys(),
      );
      const orphanedBooks = (await db.addressBooks.toArray()).filter(
        (book) =>
          book.origin.kind === "connectedAccount" &&
          !liveConnectedAccountIds.has(book.origin.connectedAccountId),
      );
      if (orphanedBooks.length > 0) {
        await db.addressBooks.bulkDelete(orphanedBooks.map((book) => book.id));
        const orphanedConnectedAccountIds = new Set(
          orphanedBooks.map((book) =>
            book.origin.kind === "connectedAccount" ? book.origin.connectedAccountId : "",
          ),
        );
        await db.syncState.bulkDelete([
          ...[...orphanedConnectedAccountIds].map(connectedAccountAddressBookTokenKey),
          ...[...orphanedConnectedAccountIds].map(connectedAccountContactTokenKey),
        ]);
      }

      // Covers both the sweep above (whole-account removal) and an ordinary
      // `AddressBook` destroy already applied this round (turning off just
      // the Contacts Facet, #206/#209's own removal path) — either way, a
      // Contact whose Address Book is no longer live goes with it.
      const liveAddressBookIds = new Set(await db.addressBooks.toCollection().primaryKeys());
      const orphanedContactIds = (await db.contacts.toArray())
        .filter((contact) => !liveAddressBookIds.has(contact.addressBookId))
        .map((contact) => contact.id);
      if (orphanedContactIds.length > 0) await db.contacts.bulkDelete(orphanedContactIds);
    },
  );
}

async function loadWindow(
  db: LocalCache,
  mailAccountId: string,
  view: ViewKey,
): Promise<ListWindow> {
  const key = listWindowKey(mailAccountId, view);
  const existing = await db.listWindows.get(key);
  if (existing) return existing;
  const created: ListWindow = { key, mailAccountId, view, oldestHeldSort: null, complete: true };
  await db.listWindows.put(created);
  return created;
}

async function pinnedThreadIds(db: LocalCache, mailAccountId: string): Promise<Set<string>> {
  return new Set(await db.cachePins.where("mailAccountId").equals(mailAccountId).primaryKeys());
}

/**
 * Truncates a window's bottom back to the floor — what keeps a bootstrap of
 * an 80k-Thread Mail Account from ever materializing 80k rows. Never called
 * synchronously off a sync write: ADR-0009 says "Eviction runs on idle,
 * never on a read path", and `applyThreadDelta` only ever *schedules* this
 * (`scheduleWindowTrim`, below) rather than awaiting it inline, so a sync
 * round's own write transaction is never held up by a sweep. The
 * byte-budgeted LRU over bodies, which has nothing to evict until bodies are
 * cached, is the other idle-time half of eviction.
 *
 * Threads that fall out are
 * deleted outright *unless* the User has one open (a cache pin) or a queued
 * Optimistic Action names it — ADR-0009's never-evictable set. Those rows
 * survive outside the window, which is exactly what "opened Threads are
 * pinned into the entity cache regardless of age" means.
 */
async function trimWindow(db: LocalCache, window: ListWindow): Promise<void> {
  const inWindow = threadsInWindow(db, window);
  if ((await inWindow.count()) <= THREAD_WINDOW_HIGH_WATER) return;

  const [floorThread] = await threadsInWindow(db, window)
    .reverse()
    .offset(THREAD_WINDOW_FLOOR - 1)
    .limit(1)
    .toArray();
  if (!floorThread) return;
  const cutoff = floorThread.sortKey;

  const evicted = await db.threads
    .where("[mailAccountId+sortKey]")
    .between([window.mailAccountId, Dexie.minKey], [window.mailAccountId, cutoff], true, false)
    .primaryKeys();

  const exempt = await evictionExempt(db, window.mailAccountId, evicted);
  await db.threads.bulkDelete(evicted.filter((id) => !exempt.has(id)));

  await db.listWindows.put({ ...window, oldestHeldSort: cutoff, complete: false });
}

/** The never-evictable set for one candidate batch: open Threads and anything unsent user intent references. */
async function evictionExempt(
  db: LocalCache,
  mailAccountId: string,
  candidates: string[],
): Promise<Set<string>> {
  const exempt = await pinnedThreadIds(db, mailAccountId);
  const referenced = await db.pendingMutations
    .where("referencedThreadIds")
    .anyOf(candidates)
    .toArray();
  for (const mutation of referenced) {
    for (const threadId of mutation.referencedThreadIds) exempt.add(threadId);
  }
  return exempt;
}

/** The window's membership as an ordered range query — never a scan, so callers can rely on its order. */
export function threadsInWindow(db: LocalCache, window: ListWindow) {
  return db.threads
    .where("[mailAccountId+sortKey]")
    .between(
      [window.mailAccountId, window.oldestHeldSort ?? Dexie.minKey],
      [window.mailAccountId, Dexie.maxKey],
      true,
      true,
    );
}

/**
 * `trimWindow`'s idle-time scheduler (ADR-0009: "Eviction runs on idle,
 * never on a read path"). `applyThreadDelta` calls `scheduleWindowTrim`
 * once per delta rather than awaiting `trimWindow` itself, so a sync round's
 * write transaction never pays for a sweep; a paginated bootstrap that calls
 * this many times in a row still only schedules one idle callback; and a
 * window is re-loaded fresh (not the possibly-stale one the caller saw) once
 * that callback actually runs.
 *
 * Falls back to `setTimeout` where `requestIdleCallback` doesn't exist
 * (Safari, and every test environment) — a short fixed delay rather than a
 * deadline, since there is no idle-deadline budget to honor there anyway.
 */
const IDLE_FALLBACK_DELAY_MS = 200;

type IdleScheduler = (run: () => void) => unknown;
type IdleCanceler = (handle: unknown) => void;

function defaultIdleScheduler(): IdleScheduler {
  const requestIdle = (globalThis as { requestIdleCallback?: (cb: () => void) => unknown })
    .requestIdleCallback;
  return requestIdle ? (run) => requestIdle(run) : (run) => setTimeout(run, IDLE_FALLBACK_DELAY_MS);
}

function defaultIdleCanceler(): IdleCanceler {
  const cancelIdle = (globalThis as { cancelIdleCallback?: (handle: unknown) => void })
    .cancelIdleCallback;
  return cancelIdle ? (handle) => cancelIdle(handle) : (handle) => clearTimeout(handle as number);
}

const pendingTrims = new Map<string, { mailAccountId: string; view: ViewKey }>();
let scheduledIdleHandle: unknown | null = null;

/** Records that this window may be over its high water; coalesces into the next idle tick. */
export function scheduleWindowTrim(mailAccountId: string, view: ViewKey = DEFAULT_VIEW): void {
  pendingTrims.set(listWindowKey(mailAccountId, view), { mailAccountId, view });
  if (scheduledIdleHandle !== null) return;
  scheduledIdleHandle = defaultIdleScheduler()(() => {
    scheduledIdleHandle = null;
    void runPendingWindowTrims();
  });
}

/**
 * Runs whatever `scheduleWindowTrim` queued against whichever `LocalCache`
 * handle is current *right now* — never the one open when the schedule was
 * made. A trim queued against a handle that's since been replaced or closed
 * (`openLocalCache`, a schema wipe) is stale: `cancelScheduledWindowTrims`
 * is what the handle-swap path calls instead of letting this run against
 * the wrong database, and a handle closed by some other means simply fails
 * this cleanly rather than throwing unhandled — there is no User-visible
 * eviction promise to keep once the cache itself is gone.
 */
async function runPendingWindowTrims(): Promise<void> {
  const due = [...pendingTrims.values()];
  pendingTrims.clear();
  const db = localCache();
  for (const { mailAccountId, view } of due) {
    try {
      const window = await loadWindow(db, mailAccountId, view);
      await trimWindow(db, window);
    } catch {
      // The handle this was queued against is gone (closed outside
      // `openLocalCache`, e.g. a test tearing down directly) — nothing left
      // to trim, and nothing here is worth surfacing as a failure.
    }
  }
}

/**
 * Test seam: runs whatever window trims `scheduleWindowTrim` has queued,
 * right now, instead of waiting on a real idle tick or a faked timer. Tests
 * that assert trimming behavior call this after the `applyThreadDelta` that
 * should trigger it.
 */
export async function flushScheduledWindowTrims(): Promise<void> {
  if (scheduledIdleHandle !== null) {
    defaultIdleCanceler()(scheduledIdleHandle);
    scheduledIdleHandle = null;
  }
  await runPendingWindowTrims();
}

/**
 * Drops any queued-but-not-yet-run window trim without executing it.
 * `openLocalCache` calls this when it swaps the handle (`local-cache.ts`):
 * a trim scheduled against the cache being replaced would otherwise fire
 * against whatever cache happens to be open once the idle tick arrives,
 * which is never correct — the seam exists precisely so a test (or a
 * schema wipe) can open a fresh database per case.
 */
export function cancelScheduledWindowTrims(): void {
  if (scheduledIdleHandle !== null) {
    defaultIdleCanceler()(scheduledIdleHandle);
    scheduledIdleHandle = null;
  }
  pendingTrims.clear();
}
