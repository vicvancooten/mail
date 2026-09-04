import type {
  Correspondent,
  GatekeeperSender,
  Label,
  MailAccount,
  Preference,
  Thread,
} from "@mail/shared";
import {
  DEFAULT_AUTO_ADVANCE_DIRECTION,
  DEFAULT_AUTO_ADVANCE_ENABLED,
  DEFAULT_UNDO_SEND_DELAY_SECONDS,
  labelId,
  normalizeSenderAddress,
  senderDomain,
} from "@mail/shared";
import { useLiveQuery } from "dexie-react-hooks";
import { useRef } from "react";
import {
  type CachedThread,
  DEFAULT_VIEW,
  type LocalCache,
  listWindowKey,
  type PendingMutation,
  type PendingUserMutation,
  type ViewKey,
} from "./db.js";
import { localCache } from "./local-cache.js";
import { threadsInWindow } from "./server-writes.js";
import { threadSortKey } from "./thread-sort-key.js";

/**
 * The Client's only read path (ADR-0010). Components subscribe to these
 * reactive reads and never see Dexie, a state token, or a queue row. Reads
 * are what the UI renders from — the Local Cache is the source of truth, not
 * a network response, so nothing here ever awaits a fetch.
 *
 * `undefined` from a hook means "the first read hasn't resolved yet", which
 * is a frame or two, not a loading state to render a spinner for.
 *
 * **`base ⊕ pending` is composed here** (#39): `readThreadWindow` overlays
 * every pending Optimistic Action onto the base row it targets before a
 * component ever sees it, so there is no path from "components read
 * through here" to "a component renders an un-overlaid base row". Dexie's
 * `liveQuery` tracks the `pendingMutations` reads this performs the same
 * way it tracks `threads` — enqueuing or resolving a mutation re-renders
 * exactly like a base-row change would.
 */

/** ADR-0010's cold start: paint the top page of the last-active list, ~50 rows, and nothing else. */
export const THREAD_PAGE_SIZE = 50;

export function useMailAccounts(): MailAccount[] | undefined {
  return useLiveQuery(() => readMailAccounts(), []);
}

/**
 * Ordered by `createdAt` so the account switcher and "first account" are
 * stable across reloads. Overlays any queued `setSignature`/
 * `setNotificationsEnabled` Optimistic Action (#54) the same way
 * `readThreadWindow` overlays a Thread's own queue — a signature edit shows
 * immediately, offline included, rather than waiting on a round trip.
 */
export async function readMailAccounts(): Promise<MailAccount[]> {
  const db = localCache();
  const accounts = await db.mailAccounts.orderBy("createdAt").toArray();
  return overlayMailAccountMutations(db, accounts);
}

async function overlayMailAccountMutations(
  db: LocalCache,
  accounts: MailAccount[],
): Promise<MailAccount[]> {
  if (accounts.length === 0) return accounts;

  const relevant = await db.pendingMutations
    .where("mailAccountId")
    .anyOf(accounts.map((account) => account.id))
    .filter(
      (mutation) =>
        mutation.intent.type === "setSignature" ||
        mutation.intent.type === "setNotificationsEnabled",
    )
    .toArray();
  if (relevant.length === 0) return accounts;

  relevant.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const byAccountId = new Map<string, PendingMutation[]>();
  for (const mutation of relevant) {
    const bucket = byAccountId.get(mutation.mailAccountId);
    if (bucket) bucket.push(mutation);
    else byAccountId.set(mutation.mailAccountId, [mutation]);
  }

  return accounts.map((account) => {
    const mutations = byAccountId.get(account.id);
    if (!mutations) return account;
    let overlaid = account;
    for (const mutation of mutations) {
      if (mutation.intent.type === "setSignature") {
        overlaid = { ...overlaid, signature: mutation.intent.signature };
      } else if (mutation.intent.type === "setNotificationsEnabled") {
        overlaid = { ...overlaid, notificationsEnabled: mutation.intent.enabled };
      }
    }
    return overlaid;
  });
}

/**
 * The synced `Preference` row (#54), before this Client has ever synced one:
 * the same defaults `sync/mutations.ts` seeds a new `users` row with, so a
 * fresh install's settings screen shows sensible values from the first paint
 * rather than a loading state — ADR-0010's "cold start reads the Local Cache,
 * never waits on a network round trip" applied to a collection with exactly
 * one row instead of thousands.
 */
function defaultPreference(): Preference {
  return {
    id: "",
    autoAdvanceEnabled: DEFAULT_AUTO_ADVANCE_ENABLED,
    autoAdvanceDirection: DEFAULT_AUTO_ADVANCE_DIRECTION,
    undoSendDelaySeconds: DEFAULT_UNDO_SEND_DELAY_SECONDS,
    updatedAt: new Date(0).toISOString(),
  };
}

export function usePreference(): Preference | undefined {
  return useLiveQuery(() => readPreference(), []);
}

/**
 * `base ⊕ pending` for the one-row `Preference` collection (#54): the same
 * overlay shape every other read gets, just keyed to "the whole row" instead
 * of a `threadId`/`mailAccountId`, because a User has exactly one.
 */
export async function readPreference(): Promise<Preference> {
  const db = localCache();
  const [rows, pending] = await Promise.all([
    db.preferences.toArray(),
    db.pendingUserMutations.orderBy("id").toArray(),
  ]);
  const base = rows[0] ?? defaultPreference();
  return applyPreferenceOverlay(base, pending);
}

function applyPreferenceOverlay(base: Preference, mutations: PendingUserMutation[]): Preference {
  let overlaid = base;
  for (const { intent } of mutations) {
    switch (intent.type) {
      case "setAutoAdvance":
        overlaid = {
          ...overlaid,
          autoAdvanceEnabled: intent.enabled,
          autoAdvanceDirection: intent.direction,
        };
        break;
      case "setUndoSendDelay":
        overlaid = { ...overlaid, undoSendDelaySeconds: intent.undoSendDelaySeconds };
        break;
    }
  }
  return overlaid;
}

/** Every Label (#43) a Mail Account has, name-ordered — the "filter by label" picker's whole data source. */
export function useLabels(mailAccountId: string | null): Label[] | undefined {
  return useLiveQuery(
    () => (mailAccountId === null ? Promise.resolve([]) : readLabels(mailAccountId)),
    [mailAccountId],
  );
}

export async function readLabels(mailAccountId: string): Promise<Label[]> {
  const rows = await localCache().labels.where("mailAccountId").equals(mailAccountId).toArray();
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * A Mail Account's synced top ~500 Correspondents (#49, compose-spec
 * §Recipient autocomplete), score-descending — already the whole ranked set
 * a recipient field needs, so the composer filters this in memory rather
 * than querying Dexie again per keystroke. This is the entire mechanism
 * behind "the first keystroke suggests from the Local Cache in <50ms": the
 * set is loaded once (reactively) and every keystroke after that is a plain
 * in-memory `Array#filter` over at most ~500 rows.
 */
export function useCorrespondents(mailAccountId: string | null): Correspondent[] | undefined {
  return useLiveQuery(
    () => (mailAccountId === null ? Promise.resolve([]) : readCorrespondents(mailAccountId)),
    [mailAccountId],
  );
}

export async function readCorrespondents(mailAccountId: string): Promise<Correspondent[]> {
  const rows = await localCache()
    .correspondents.where("mailAccountId")
    .equals(mailAccountId)
    .toArray();
  return rows.sort((left, right) => right.score - left.score);
}

/**
 * One row of the Screener (#56, poc-spec.md §Gatekeeper v1): "the Screener
 * lists held *senders* ... one decision per stranger, not per message." Built
 * entirely from the Local Cache's own `threads` table — every held Thread
 * already carries `heldSender` (#55), so there is nothing here to fetch from
 * the Sync Backend, and the grouping is reactive the same way every other
 * Screen is.
 */
export interface ScreenerSenderGroup {
  /** The Mail Account holding this sender — every decision (#82) targets this account, never the whole Scope. */
  mailAccountId: string;
  /** The normalized `From` address holding these Threads — what an Approve/Deny/Block decision targets. */
  address: string;
  /** The best display name across the held Threads, or `null` if none carried one. */
  name: string | null;
  threadIds: string[];
  threadCount: number;
  messageCount: number;
  /** The most recently arrived held Thread's subject — the message peek's headline. */
  subject: string;
  /** The most recently arrived held Thread's Snippet — the message peek's body. */
  snippet: string | null;
  /**
   * The earliest `lastMessageAt` among this sender's held Threads — the wire
   * `Thread` carries no Screening-Hold timestamp of its own (`heldAt` is
   * backend-only bookkeeping), so this is the Client's own proxy for "how
   * long has this stranger been waiting", and what the Screener and the
   * Inbox banner (#56) both order/gate on.
   */
  heldSince: string;
}

/** Whether `sender` (an Optimistic Action in flight) targets `heldAddress` — an exact match for `address` scope, a domain suffix match for `domain` scope (the overflow convenience, poc-spec.md). */
function matchesGatekeeperSender(heldAddress: string, sender: GatekeeperSender): boolean {
  const value = normalizeSenderAddress(sender.value);
  return sender.scope === "address" ? heldAddress === value : senderDomain(heldAddress) === value;
}

/**
 * Senders a Screener decision is already queued for (#56, #102):
 * `approveSender`/`denySender`/`blockSender`/`spamSender` name no Thread
 * (`mutation-queue.ts`'s own doc comment — "the Screener's own optimistic
 * feel comes from the row leaving the Screener list"), so this is the
 * overlay that makes a decision hide its row immediately, before the Sync
 * Backend has answered.
 */
async function decidedSenders(db: LocalCache, mailAccountId: string): Promise<GatekeeperSender[]> {
  const pending = await db.pendingMutations.where("mailAccountId").equals(mailAccountId).toArray();
  return pending.flatMap((mutation) =>
    mutation.intent.type === "approveSender" ||
    mutation.intent.type === "denySender" ||
    mutation.intent.type === "blockSender" ||
    mutation.intent.type === "spamSender"
      ? [mutation.intent.sender]
      : [],
  );
}

async function readScreenerSendersForAccount(
  mailAccountId: string,
): Promise<ScreenerSenderGroup[]> {
  const db = localCache();
  const held = await db.threads
    .where("mailAccountId")
    .equals(mailAccountId)
    .filter((thread) => thread.heldSender !== null)
    .toArray();
  if (held.length === 0) return [];

  const decided = await decidedSenders(db, mailAccountId);
  const bySender = new Map<string, CachedThread[]>();
  for (const thread of held) {
    const address = thread.heldSender;
    if (!address || decided.some((sender) => matchesGatekeeperSender(address, sender))) continue;
    const bucket = bySender.get(address);
    if (bucket) bucket.push(thread);
    else bySender.set(address, [thread]);
  }

  const groups: ScreenerSenderGroup[] = [];
  for (const [address, threads] of bySender) {
    // Newest first, so the peek shows what this sender most recently said.
    threads.sort((left, right) =>
      (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? ""),
    );
    const peek = threads[0];
    if (!peek) continue;
    const name =
      threads
        .flatMap((thread) => thread.participants)
        .find((participant) => participant.address.toLowerCase() === address && participant.name)
        ?.name ?? null;
    const heldSince = threads.reduce(
      (earliest, thread) =>
        thread.lastMessageAt && thread.lastMessageAt < earliest ? thread.lastMessageAt : earliest,
      peek.lastMessageAt ?? "",
    );
    groups.push({
      mailAccountId,
      address,
      name,
      threadIds: threads.map((thread) => thread.id),
      threadCount: threads.length,
      messageCount: threads.reduce((sum, thread) => sum + thread.messageCount, 0),
      subject: peek.subject,
      snippet: peek.snippet,
      heldSince,
    });
  }

  // Oldest hold first (poc-spec.md's Screener is a queue to work through, not a ranked list).
  return groups.sort((left, right) => left.heldSince.localeCompare(right.heldSince));
}

/**
 * One Mail Account's cluster of held senders (#82): "with several Mail
 * Accounts in Scope, held mail is grouped by account, so the User knows
 * whose stranger they are admitting". `accountEmail` is what a group header
 * names — `readScreenerSenders` below only ever includes an account here
 * once it actually has a hold, so a quiet account in Scope contributes no
 * empty section.
 */
export interface ScreenerAccountGroup {
  mailAccountId: string;
  accountEmail: string;
  senders: ScreenerSenderGroup[];
}

/**
 * The Screener's read across Account Scope (#73, #82), in Scope order —
 * Scope's own primary-first ordering is what decides which account's cluster
 * leads. Per-account grouping, not a merged/re-sorted queue: a decision is
 * already scoped to one Mail Account (`ScreenerSenderGroup.mailAccountId`),
 * and interleaving strangers from different accounts by `heldSince` alone
 * would make "whose stranger is this" a second read instead of the section
 * it is already standing in.
 */
export async function readScreenerSenders(
  accountScope: readonly string[],
): Promise<ScreenerAccountGroup[]> {
  if (accountScope.length === 0) return [];
  const accounts = await readMailAccounts();
  const emailById = new Map(accounts.map((account) => [account.id, account.emailAddress]));

  const groups = await Promise.all(
    accountScope.map(async (mailAccountId) => ({
      mailAccountId,
      accountEmail: emailById.get(mailAccountId) ?? mailAccountId,
      senders: await readScreenerSendersForAccount(mailAccountId),
    })),
  );
  return groups.filter((group) => group.senders.length > 0);
}

export function useScreenerSenders(
  accountScope: readonly string[],
): ScreenerAccountGroup[] | undefined {
  const key = accountScope.join(",");
  return useLiveQuery(() => readScreenerSenders(accountScope), [key]);
}

export interface ThreadWindowPage {
  /** Newest first. */
  threads: CachedThread[];
  /**
   * False when the window has been truncated at the bottom: there is older
   * mail the Client does not hold, and the list must end with an explicit
   * affordance rather than pretending it reached the beginning.
   */
  complete: boolean;
}

export interface ThreadWindowOptions {
  view?: ViewKey;
  limit?: number;
}

/**
 * `mailAccountId` is Account Scope (#73) as much as a single account: an
 * array merges every named account's Threads into one newest-first list
 * (`readThreadWindow`'s own doc comment). The dependency list keys off a
 * joined string rather than the array reference itself, so a caller handing
 * in a fresh-identity-but-same-contents array on every render (a Scope
 * recomputed from `MailAccount[]`, say) doesn't requery every frame.
 */
export function useThreadWindow(
  mailAccountId: string | readonly string[] | null,
  { view = DEFAULT_VIEW, limit = THREAD_PAGE_SIZE }: ThreadWindowOptions = {},
): ThreadWindowPage | undefined {
  const ids: readonly string[] =
    mailAccountId === null ? [] : Array.isArray(mailAccountId) ? mailAccountId : [mailAccountId];
  const key = ids.join(",");
  return useLiveQuery(
    () =>
      ids.length === 0
        ? Promise.resolve({ threads: [], complete: true })
        : readThreadWindow(ids, { view, limit }),
    [key, view, limit],
  );
}

/**
 * A `view`'s membership test over `all`'s already-overlaid contents (#74).
 * `inInbox` (#42) is the Inbox's whole filter, applied here so an
 * archive/trash still queued hides its Thread at the same instant as one the
 * Sync Backend already confirmed — no flicker between "optimistically
 * hidden" and "actually gone" as the mutation dequeues. A Screening Hold
 * (#56, ADR-0008) filters the same way: held mail keeps `inInbox: true` (it
 * hasn't been archived or trashed, just not shown yet) so it must be
 * excluded here explicitly — the Screener is where it renders instead.
 *
 * Archive/Trash read `folderRole` rather than `inInbox` — the one field that
 * tells the two apart (`@mail/shared`'s `threadSchema` doc comment); Sent
 * and Pinned are cross-folder by design (poc-spec.md: the sidebar's Pinned
 * view "shows pinned Threads from every folder") and each excludes Trash,
 * the same "Trash overrides everything else" convention ordinary mail
 * clients use, so a trashed Thread doesn't linger in either. Snoozed (#76)
 * reads `snoozeUntil` rather than `inInbox`, the same "one field says which"
 * shape `folderRole` gives Archive/Trash — `inInbox` alone can't tell a
 * snoozed Thread apart from an archived or trashed one, all three being
 * `false` — and excludes Trash the same way Sent/Pinned do.
 */
function filterByView(threads: CachedThread[], view: ViewKey): CachedThread[] {
  if (typeof view !== "string") {
    return threads.filter(
      (thread) => thread.inInbox && !thread.heldSender && thread.labelIds.includes(view.labelId),
    );
  }
  switch (view) {
    case "all":
      return threads.filter((thread) => thread.inInbox && !thread.heldSender);
    case "archive":
      return threads.filter((thread) => thread.folderRole === "archive");
    case "trash":
      return threads.filter((thread) => thread.folderRole === "trash");
    case "sent":
      return threads.filter((thread) => thread.hasSentMessage && thread.folderRole !== "trash");
    case "pinned":
      return threads.filter((thread) => thread.pinned && thread.folderRole !== "trash");
    case "snoozed":
      return threads.filter(
        (thread) => thread.snoozeUntil !== null && thread.folderRole !== "trash",
      );
  }
}

/** One (Mail Account, view)'s filtered, pinned-first-partitioned Threads, unsliced — `readThreadWindow`'s per-account building block, merged across Account Scope (#73) before the `limit` slice is taken. */
interface AccountWindowParts {
  pinned: CachedThread[];
  rest: CachedThread[];
  /** `true` when this Mail Account has no window at all (never synced) — trivially "complete", same as `readThreadWindow`'s own no-window case. */
  complete: boolean;
}

async function readAccountWindowParts(
  db: LocalCache,
  mailAccountId: string,
  view: ViewKey,
): Promise<AccountWindowParts> {
  const window = await db.listWindows.get(listWindowKey(mailAccountId, "all"));
  if (!window) return { pinned: [], rest: [], complete: true };

  const held = await threadsInWindow(db, window).reverse().toArray();
  const overlaid = await overlayPendingMutations(db, held);
  const filtered = filterByView(overlaid, view);

  return {
    pinned: filtered.filter((t) => t.pinned),
    rest: filtered.filter((t) => !t.pinned),
    complete: window.complete,
  };
}

/** Newest-first by the same `sortKey` the `[mailAccountId+sortKey]` index orders by — the merge step Account Scope (#73) needs once a partition spans more than one Mail Account's already-sorted array. */
function bySortKeyDescending(left: CachedThread, right: CachedThread): number {
  return right.sortKey.localeCompare(left.sortKey);
}

/**
 * The top `limit` Threads across one or several Mail Accounts (Account
 * Scope, #73) for one view, newest first — Pinned Threads (#43) sorted
 * ahead of the rest regardless of their own date, within that. A label
 * `view` (`db.ts#ViewKey`) is a filter *over* the `all` window's
 * already-loaded contents rather than a second server-synced window, so it
 * fetches `all`'s full held range (not just `limit`) before filtering — the
 * `[mailAccountId+sortKey]` index still gives the order, filtering by
 * `labelIds` just thins what passes through.
 *
 * Scoped to several Mail Accounts, each account's window is read and
 * partitioned independently, then the pinned and unpinned partitions are
 * each merged by `sortKey` — a single global newest-first order rather than
 * one account's Threads run before another's. `complete` is the AND of every
 * scoped account's own window: the list can claim "nothing older to load"
 * only once every account in Scope agrees.
 */
export async function readThreadWindow(
  mailAccountId: string | readonly string[],
  { view = DEFAULT_VIEW, limit = THREAD_PAGE_SIZE }: ThreadWindowOptions = {},
): Promise<ThreadWindowPage> {
  const ids = Array.isArray(mailAccountId) ? mailAccountId : [mailAccountId as string];
  if (ids.length === 0) return { threads: [], complete: true };

  const db = localCache();
  const parts = await Promise.all(ids.map((id) => readAccountWindowParts(db, id, view)));

  const pinned = parts.flatMap((part) => part.pinned).sort(bySortKeyDescending);
  const rest = parts.flatMap((part) => part.rest).sort(bySortKeyDescending);
  const ordered = [...pinned, ...rest];

  // A page can come back short of `limit` when the window holds Threads
  // already filtered out above (out of the Inbox, or unlabeled); `onLoadMore`
  // still works, it just may need an extra round to fill the visible page —
  // acceptable at PoC scope, and the window-admission side of this
  // (`server-writes.ts`) is a reasonable follow-up if it ever isn't.
  return { threads: ordered.slice(0, limit), complete: parts.every((part) => part.complete) };
}

/**
 * `base ⊕ pending`: for every Thread on the page, applies the queued
 * Optimistic Actions that name it, oldest first (`id` — a ULID — sorts by
 * creation time, which is `order what you assert on` rather than trusting
 * an unordered `anyOf` scan). Both intents are absolute sets, so applying
 * more than one is just "last one wins", never a fold that needs the base
 * value to seed it.
 */
/**
 * Exported for `useSearchResultThreads` below (#51): a search result row can
 * name a Thread this Client has queued a triage action against without ever
 * having synced it into a list window, so the same overlay `readThreadWindow`
 * uses is what a result row needs too — one overlay mechanism, not two.
 */
export async function overlayPendingMutations(
  db: LocalCache,
  threads: CachedThread[],
): Promise<CachedThread[]> {
  if (threads.length === 0) return threads;

  const threadIds = threads.map((thread) => thread.id);
  const relevant = await db.pendingMutations
    .where("referencedThreadIds")
    .anyOf(threadIds)
    .toArray();
  if (relevant.length === 0) return threads;

  relevant.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const byThreadId = new Map<string, PendingMutation[]>();
  for (const mutation of relevant) {
    for (const threadId of mutation.referencedThreadIds) {
      const bucket = byThreadId.get(threadId);
      if (bucket) bucket.push(mutation);
      else byThreadId.set(threadId, [mutation]);
    }
  }

  return threads.map((thread) => {
    const mutations = byThreadId.get(thread.id);
    return mutations ? applyOverlay(thread, mutations) : thread;
  });
}

function applyOverlay(thread: CachedThread, mutations: PendingMutation[]): CachedThread {
  let overlaid = thread;
  for (const mutation of mutations) {
    switch (mutation.intent.type) {
      case "setStarred":
        overlaid = { ...overlaid, starred: mutation.intent.starred };
        break;
      case "setRead":
        // Mirrors `sync/mutations.ts`'s backend semantics exactly: the
        // intent sets `\Seen` on every Message in the Thread, so the
        // overlay's `unreadCount` is 0 (read) or every Message (unread),
        // never an in-between guess.
        overlaid = { ...overlaid, unreadCount: mutation.intent.read ? 0 : overlaid.messageCount };
        break;
      case "archive":
      case "trash":
        // The Thread's fate is sealed the instant the action is queued —
        // `readThreadWindow` drops anything with `inInbox: false` from the
        // page, offline included, before any server round trip. Also clears
        // `snoozeUntil` (#76), mirroring `sync/mutations.ts`'s own archive/
        // trash case: archiving/trashing a still-snoozed Thread overrides
        // Snooze, so it must drop out of the Snoozed view the same instant
        // too, not just the Inbox.
        overlaid = { ...overlaid, inInbox: false, snoozeUntil: null };
        break;
      case "snooze":
        // Same immediate-hide shape as archive/trash above, plus the field
        // that makes the Snoozed view's own filter (`filterByView`) admit it
        // the instant it's queued, offline included.
        overlaid = { ...overlaid, inInbox: false, snoozeUntil: mutation.intent.until };
        break;
      case "setPinned":
        overlaid = { ...overlaid, pinned: mutation.intent.pinned };
        break;
      case "applyLabel": {
        // Same deterministic id both sides derive independently (#43) — see
        // `packages/shared/src/labels.ts`'s doc comment.
        const id = labelId(overlaid.mailAccountId, mutation.intent.name);
        if (!overlaid.labelIds.includes(id)) {
          overlaid = { ...overlaid, labelIds: [...overlaid.labelIds, id] };
        }
        break;
      }
      case "removeLabel": {
        const id = labelId(overlaid.mailAccountId, mutation.intent.name);
        overlaid = {
          ...overlaid,
          labelIds: overlaid.labelIds.filter((existing) => existing !== id),
        };
        break;
      }
    }
  }
  return overlaid;
}

/**
 * The Client prefilter's own filter fields (#51, `docs/search-ux-spec.md`
 * §Client prefilter, ADR-0016). Deliberately a narrower shape than the
 * Sync Backend's `SearchRequest` (`@mail/shared`): the Local Cache holds one
 * per-account Thread window with no per-Folder membership at all (`db.ts`'s
 * `ViewKey` doc comment — "the wire Thread carries no Folder"), so `folder`
 * here can only ever mean `"inbox"` (via `Thread.inInbox`); every other
 * `in:` value the User might type has nothing local to check it against and
 * is silently not enforced offline, same as `before`/`after` matching only
 * `lastMessageAt`. This is exactly the prefilter's own limits made explicit
 * — "a prefilter, not a second ranker" (ADR-0016) — never a bug to fix here.
 */
export interface SearchPrefilterFilters {
  text: string;
  from?: string;
  to?: string;
  hasAttachment?: boolean;
  folder?: string;
  label?: string;
  after?: string;
  before?: string;
}

function matchesParticipant(thread: CachedThread, needle: string): boolean {
  const lower = needle.toLowerCase();
  return thread.participants.some(
    (participant) =>
      (participant.name?.toLowerCase().includes(lower) ?? false) ||
      participant.address.toLowerCase().includes(lower),
  );
}

function withinDateRange(thread: CachedThread, after?: string, before?: string): boolean {
  if (!thread.lastMessageAt) return !after && !before;
  const at = Date.parse(thread.lastMessageAt);
  if (Number.isNaN(at)) return true;
  if (after) {
    const bound = Date.parse(after);
    if (!Number.isNaN(bound) && at < bound) return false;
  }
  if (before) {
    const bound = Date.parse(before);
    // Inclusive on the calendar day, matching the Sync Backend's own `before:` (ADR-0016).
    if (!Number.isNaN(bound) && at > bound + 24 * 60 * 60 * 1000 - 1) return false;
  }
  return true;
}

/**
 * The Client prefilter (#51, ADR-0016): "case-insensitive substring over
 * subject, sender name, sender address and Snippet across the bounded Local
 * Cache, date-ordered." Runs over every held Thread for the account
 * regardless of which list window it came from — the point is "what's
 * already on this device", not "what's in the Inbox right now" — with
 * pending Optimistic Actions overlaid the same way every other read is
 * (ADR-0010), so an offline archive is reflected instantly here too.
 */
export async function readSearchPrefilter(
  mailAccountId: string,
  filters: SearchPrefilterFilters,
): Promise<CachedThread[]> {
  const db = localCache();
  const all = await db.threads.where("mailAccountId").equals(mailAccountId).toArray();
  const overlaid = await overlayPendingMutations(db, all);

  let labelIdFilter: string | null = null;
  if (filters.label) {
    const labels = await readLabels(mailAccountId);
    const match = labels.find((label) => label.name.toLowerCase() === filters.label?.toLowerCase());
    // No such Label held locally: nothing can match, rather than silently
    // ignoring the filter and showing everything.
    labelIdFilter = match?.id ?? "__no-local-match__";
  }

  const text = filters.text.trim().toLowerCase();
  const matched = overlaid.filter((thread) => {
    if (filters.folder && filters.folder.toLowerCase() === "inbox" && !thread.inInbox) return false;
    if (filters.hasAttachment && !thread.hasAttachments) return false;
    if (labelIdFilter && !thread.labelIds.includes(labelIdFilter)) return false;
    if (filters.from && !matchesParticipant(thread, filters.from)) return false;
    if (filters.to && !matchesParticipant(thread, filters.to)) return false;
    if (!withinDateRange(thread, filters.after, filters.before)) return false;
    if (text.length === 0) return true;
    return (
      thread.subject.toLowerCase().includes(text) ||
      (thread.snippet?.toLowerCase().includes(text) ?? false) ||
      matchesParticipant(thread, text)
    );
  });

  return matched.sort((left, right) =>
    right.sortKey < left.sortKey ? -1 : right.sortKey > left.sortKey ? 1 : 0,
  );
}

/**
 * A live query re-subscribes on every keystroke (`mailAccountId`/`filters`
 * both change), and `useLiveQuery` returns `undefined` for every render in
 * between the old subscription tearing down and the new one's first emit —
 * by design, not a bug in it. Falling through to `?? []` at each call site
 * used to render "No matches" for that one frame (#100, bug 5); holding the
 * last non-`undefined` result across that gap instead means the prefilter
 * only ever *replaces* what's on screen, never blanks it first.
 */
export function useSearchPrefilter(
  mailAccountId: string | null,
  filters: SearchPrefilterFilters,
): CachedThread[] | undefined {
  const lastRef = useRef<CachedThread[] | undefined>(undefined);
  const live = useLiveQuery(
    () =>
      mailAccountId === null ? Promise.resolve([]) : readSearchPrefilter(mailAccountId, filters),
    [mailAccountId, JSON.stringify(filters)],
  );
  if (live !== undefined) lastRef.current = live;
  // `mailAccountId === null` means search itself isn't engaged (or is below
  // the floor) rather than "still loading" — that's a real empty, not a gap
  // to paper over, so it isn't held onto the way an in-flight resubscribe is.
  return mailAccountId === null ? live : (live ?? lastRef.current);
}

/**
 * A search result row's live thread (#51, `docs/search-ux-spec.md` §Acting
 * on a result): prefers the Local Cache's own base row — present once
 * `materializeSearchResultThread` (`cache-pins.ts`) has pinned this result,
 * and kept current by every later sync round the same as any other pinned
 * Thread — falling back to the server's own snapshot (`SearchResult.thread`)
 * for a row nothing has acted on yet. Overlaying pending mutations on top
 * either way is what makes "acting on a result... the row stays in place,
 * visibly changed" (ADR-0016) work: archiving queues a mutation, the base
 * row hasn't changed yet, and this overlay is what shows the change anyway
 * — and what un-shows it again if the mutation is later rejected, the exact
 * same rollback every other Thread read already gets for free.
 */
export function useSearchResultThreads(results: readonly { thread: Thread }[]): CachedThread[] {
  const ids = results.map((result) => result.thread.id);
  const snapshots = new Map(
    results.map((result) => [
      result.thread.id,
      { ...result.thread, sortKey: threadSortKey(result.thread) },
    ]),
  );
  const overlaid = useLiveQuery(async () => {
    if (ids.length === 0) return [];
    const db = localCache();
    const live = await db.threads.where("id").anyOf(ids).toArray();
    const liveById = new Map(live.map((thread) => [thread.id, thread]));
    const merged: CachedThread[] = [];
    for (const id of ids) {
      const thread = liveById.get(id) ?? snapshots.get(id);
      if (thread) merged.push(thread);
    }
    return overlayPendingMutations(db, merged);
    // `ids.join(",")` is the real dependency: `snapshots`/`ids` are derived
    // fresh from `results` every render, so re-keying on their identity
    // would resubscribe on every render for no reason.
  }, [ids.join(",")]);
  return overlaid ?? [...snapshots.values()];
}
