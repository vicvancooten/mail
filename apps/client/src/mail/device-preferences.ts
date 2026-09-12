/**
 * View mode and last-active Mail Account are both **Device Preferences**
 * (CONTEXT.md): they deliberately never sync, because they mean something
 * different on each device. #54 builds the formal Device Preferences seam;
 * until then this is a plain `localStorage` stand-in — still device-local,
 * still never synced, just not routed through a settings collection yet.
 *
 * Stream mode (a Split/List toggle, `mail.devicePref.streamMode`) lived here
 * too until #105 redefined Stream as its own full-screen route
 * (`router/routes.tsx#streamRoute`) rather than a view mode — there is
 * nothing left to prefer, so the key and its read/write pair are retired
 * along with it.
 *
 * Every read/write is wrapped: `localStorage` can throw (private browsing,
 * a full quota, a disabled setting), and a lost preference costs nothing
 * more than falling back to the default — never worth surfacing as an
 * error on a triage surface that is silent when healthy.
 *
 * View mode, list density and sidebar-collapsed are reactive (#99): each
 * gets a `use*` hook built on `useSyncExternalStore`, the same shape
 * `theme/device-theme.ts#useAppearance` already established — a write from
 * `mail/TopBar.tsx`/`Sidebar.tsx` and one from Settings' "This device" page
 * reach every mounted subscriber the same instant, so the two surfaces can
 * never drift out of sync (the reason this ticket exists: `SettingsSection`
 * used to have no reactive subscription to these at all).
 *
 * Despite the `mail/` path (legacy from #54, the first Device Preference
 * this file ever held — not a scope boundary), this is the Client's one
 * Device Preference module (#272): every App's per-device settings route
 * through here, Tasks' own three below and Calendar's hidden-Calendar
 * set/"show Tasks on grid" toward the bottom included. The one exception is
 * Appearance (`theme/device-theme.ts`) — it has to run and paint before the
 * rest of the bundle even loads (`main.tsx` calls it at the top level,
 * ahead of React), so it keeps its own tiny read/write pair rather than
 * importing this module and dragging the rest of the Client in with it.
 */

import { useCallback, useSyncExternalStore } from "react";

export type ViewMode = "split" | "list";
export const DEFAULT_VIEW_MODE: ViewMode = "split";

/** The thread list's row density (#54, CONTEXT.md's Device Preference): deliberately never synced — density means something different per screen. */
export type ListDensity = "comfortable" | "compact";
export const DEFAULT_LIST_DENSITY: ListDensity = "comfortable";

const VIEW_MODE_KEY = "mail.devicePref.viewMode";
const OPEN_COMPOSER_KEY = "mail.devicePref.openComposerId";
const LIST_DENSITY_KEY = "mail.devicePref.listDensity";

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Best-effort; see module docstring.
  }
}

export function readViewMode(): ViewMode {
  const stored = readStorage(VIEW_MODE_KEY);
  return stored === "split" || stored === "list" ? stored : DEFAULT_VIEW_MODE;
}

const viewModeListeners = new Set<() => void>();

export function writeViewMode(mode: ViewMode): void {
  writeStorage(VIEW_MODE_KEY, mode);
  for (const listener of viewModeListeners) listener();
}

function subscribeViewMode(listener: () => void): () => void {
  viewModeListeners.add(listener);
  return () => viewModeListeners.delete(listener);
}

/** Reactive pair for View mode (Split/List) — read by `mail/MailSection.tsx`, written from there and from `settings/ThisDeviceSection.tsx`; both stay in sync. */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const mode = useSyncExternalStore(subscribeViewMode, readViewMode, () => DEFAULT_VIEW_MODE);
  const setMode = useCallback((next: ViewMode) => writeViewMode(next), []);
  return [mode, setMode];
}

export function readListDensity(): ListDensity {
  const stored = readStorage(LIST_DENSITY_KEY);
  return stored === "comfortable" || stored === "compact" ? stored : DEFAULT_LIST_DENSITY;
}

const listDensityListeners = new Set<() => void>();

export function writeListDensity(density: ListDensity): void {
  writeStorage(LIST_DENSITY_KEY, density);
  for (const listener of listDensityListeners) listener();
}

function subscribeListDensity(listener: () => void): () => void {
  listDensityListeners.add(listener);
  return () => listDensityListeners.delete(listener);
}

/** Reactive pair for list density — read by `mail/MailSection.tsx`, written from there and from `settings/ThisDeviceSection.tsx`; both stay in sync. */
export function useListDensity(): [ListDensity, (density: ListDensity) => void] {
  const density = useSyncExternalStore(
    subscribeListDensity,
    readListDensity,
    () => DEFAULT_LIST_DENSITY,
  );
  const setDensity = useCallback((next: ListDensity) => writeListDensity(next), []);
  return [density, setDensity];
}

/**
 * Whether the folder rail (`mail/Sidebar.tsx`, shadcn's `Sidebar` with
 * `collapsible="icon"` since #93) is collapsed to icons-only (#99): a
 * Device Preference — a phone and a widescreen monitor want different
 * answers — set from `settings/ThisDeviceSection.tsx` *or* the rail's own
 * collapse toggle, and read reactively by every mounted `SidebarProvider`
 * the instant either writes, same shape as view mode/density above (and
 * Appearance's `theme/device-theme.ts`).
 */
const SIDEBAR_COLLAPSED_KEY = "mail.devicePref.sidebarCollapsed";

export function readSidebarCollapsed(): boolean {
  return readStorage(SIDEBAR_COLLAPSED_KEY) === "1";
}

const sidebarCollapsedListeners = new Set<() => void>();

export function writeSidebarCollapsed(collapsed: boolean): void {
  writeStorage(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  for (const listener of sidebarCollapsedListeners) listener();
}

function subscribeSidebarCollapsed(listener: () => void): () => void {
  sidebarCollapsedListeners.add(listener);
  return () => sidebarCollapsedListeners.delete(listener);
}

export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    readSidebarCollapsed,
    () => false,
  );
  const setCollapsed = useCallback((next: boolean) => writeSidebarCollapsed(next), []);
  return [collapsed, setCollapsed];
}

/**
 * Account Scope (#73, `mail#66` §"Account Scope in the Client's own chrome";
 * repointed at Connected Accounts in #207): which of the User's Connected
 * Accounts the Client is currently showing — Client-level chrome rather than
 * Mail-level, "because narrowing to one account is a question every App
 * answers". Device-local by the same reasoning as the rest of this file:
 * which accounts you're looking at right now means something different on
 * each device.
 *
 * Held as **Connected Account** ids since #207 (`AccountScope.tsx`'s own
 * doc comment on why the picker itself moved), not Mail Account ids —
 * deliberately the *same* storage key a pre-#207 device already has a Mail
 * Account id array under: those ids live in a different id space
 * (`packages/shared/src/mail-accounts.ts#connectedAccountId` is never equal
 * to its own Mail Account's `id`), so `resolveAccountScope` below already
 * treats every one of them as "names nothing that still exists" and falls
 * back to "every account" the first time it's read — the same one-time,
 * no-migration, no-message reset a device upgrading off the older
 * `mail.devicePref.lastAccountId` key got.
 *
 * Stored as an id array rather than a set — order carries no meaning of its
 * own (`resolveAccountScope` below is what a caller reads back), but a plain
 * JSON array is the simplest thing that survives `JSON.stringify`/`parse`.
 */
export type AccountScope = readonly string[];

const ACCOUNT_SCOPE_KEY = "mail.devicePref.accountScope";

function parseAccountScope(stored: string | null): AccountScope | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.every((entry): entry is string => typeof entry === "string") ? parsed : null;
  } catch {
    return null;
  }
}

// `readAccountScope` is `useAccountScope.ts`'s own `useSyncExternalStore`
// snapshot (#96) — React's contract there requires it to return the *same*
// reference across calls when nothing actually changed, or every render
// schedules another ("Maximum update depth exceeded"). A bare
// `JSON.parse` would fail that: it returns a fresh array every call even
// when the underlying string didn't move. Cached on the raw string itself
// (not just "have we read since the last write") so an external
// `localStorage.clear()` — every test file's own `afterEach` — is picked
// up too, not just this module's own `writeAccountScope`.
let cachedRaw: string | null | undefined;
let cachedParsed: AccountScope | null = null;

/** The stored Scope verbatim, or `null` if never set or unreadable — callers resolve that against the live account list (`resolveAccountScope`), never render it directly. */
export function readAccountScope(): AccountScope | null {
  const stored = readStorage(ACCOUNT_SCOPE_KEY);
  if (stored !== cachedRaw) {
    cachedRaw = stored;
    cachedParsed = parseAccountScope(stored);
  }
  return cachedParsed;
}

/** Scope "cannot be emptied" (#73's acceptance criteria) — a no-op guard here too, so a caller that skips the UI-level guard can't wipe a device's Scope preference by accident. */
export function writeAccountScope(accountIds: AccountScope): void {
  if (accountIds.length === 0) return;
  writeStorage(ACCOUNT_SCOPE_KEY, JSON.stringify(accountIds));
  for (const listener of accountScopeListeners) listener();
}

const accountScopeListeners = new Set<() => void>();

/** Reactive subscription for the stored Scope (#96): the control moved from `mail/TopBar.tsx` into the Hub (`RootLayout.tsx`), while `MailSection.tsx` still resolves it (via `useAccountScope.ts#deriveMailAccountScope`, #207) against the Connected Accounts that actually carry a Mail Facet to filter the Thread list — same "one write reaches every mounted subscriber" shape as view mode/density/sidebar-collapsed above, or the two would drift the instant they're rendered by two different components. */
export function subscribeAccountScope(listener: () => void): () => void {
  accountScopeListeners.add(listener);
  return () => accountScopeListeners.delete(listener);
}

/**
 * The stored Scope narrowed to accounts that still exist, falling back to
 * "every account" — the documented default — the moment that narrowing (or a
 * never-set/corrupt read) would otherwise leave nothing selected. Generic
 * over anything with an `id` (#207: Connected Accounts now, Mail Accounts
 * pre-#207) rather than tied to one collection's own type. Order follows
 * `accounts` (created-at, per `useConnectedAccounts`'/`useMailAccounts`' own
 * doc comments), not the stored array, so a scope read back after an account
 * was removed and re-added doesn't strand it out of its usual place.
 */
export function resolveAccountScope(
  stored: AccountScope | null,
  accounts: readonly { id: string }[],
): AccountScope {
  const known = new Set(accounts.map((account) => account.id));
  const narrowed = stored?.filter((id) => known.has(id)) ?? [];
  if (narrowed.length > 0) {
    const inScope = new Set(narrowed);
    return accounts.filter((account) => inScope.has(account.id)).map((account) => account.id);
  }
  return accounts.map((account) => account.id);
}

/**
 * Which Composition's composer is open, if any (#45). Device-local by the
 * same reasoning as the rest of this file, and what lets a reload — a
 * closed tab, a crashed one, a plain refresh — reopen the same composer
 * rather than the offline-durable draft (`store/compositions.ts`) sitting
 * unreachable in the Local Cache with nothing on screen pointing at it.
 */
export function readOpenComposerId(): string | null {
  return readStorage(OPEN_COMPOSER_KEY);
}

export function writeOpenComposerId(id: string): void {
  writeStorage(OPEN_COMPOSER_KEY, id);
}

export function clearOpenComposerId(): void {
  try {
    globalThis.localStorage?.removeItem(OPEN_COMPOSER_KEY);
  } catch {
    // Best-effort; see module docstring.
  }
}

/**
 * Recent searches (#51, `docs/search-ux-spec.md` §The empty field): "a
 * recent search *is* its string" — the raw `?q=` text and nothing else, so
 * storing one is exactly this file's `readStorage`/`writeStorage` pattern.
 * A per-device convenience and "a small privacy footgun on a shared
 * machine, which is why the clear is not optional" — `clearRecentSearches`
 * exists for exactly that button.
 */
const RECENT_SEARCHES_KEY = "mail.devicePref.recentSearches";
const RECENT_SEARCHES_LIMIT = 5;

export function readRecentSearches(): string[] {
  const stored = readStorage(RECENT_SEARCHES_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** Most-recent-first, deduped, capped at ~5 (spec: "the last ~5 recent searches"). A no-op for an empty/whitespace-only query. */
export function addRecentSearch(query: string): void {
  const trimmed = query.trim();
  if (trimmed.length === 0) return;
  const deduped = [trimmed, ...readRecentSearches().filter((entry) => entry !== trimmed)];
  writeStorage(RECENT_SEARCHES_KEY, JSON.stringify(deduped.slice(0, RECENT_SEARCHES_LIMIT)));
}

export function clearRecentSearches(): void {
  try {
    globalThis.localStorage?.removeItem(RECENT_SEARCHES_KEY);
  } catch {
    // Best-effort; see module docstring.
  }
}

/**
 * Palette command usage (#148, `docs/search-ux-spec.md` §The empty field:
 * "the most-used commands"): a plain run-count per Action id, incremented
 * only when a command is *run from the Palette* — the Palette's own
 * discoverability surface, not every surface (row cluster, Reader, the
 * global keyboard listener) an action can run from, each of which would
 * otherwise need its own call site here for a count the empty state alone
 * reads. Device-local like the rest of this file: which commands you reach
 * for from the Palette is a per-device habit, not something to sync.
 */
const COMMAND_USAGE_KEY = "mail.devicePref.commandUsage";

export function readCommandUsage(): Readonly<Record<string, number>> {
  const stored = readStorage(COMMAND_USAGE_KEY);
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [id, count] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count)) result[id] = count;
    }
    return result;
  } catch {
    return {};
  }
}

export function recordCommandUsage(commandId: string): void {
  const usage = { ...readCommandUsage() };
  usage[commandId] = (usage[commandId] ?? 0) + 1;
  writeStorage(COMMAND_USAGE_KEY, JSON.stringify(usage));
}

/**
 * Whether the one-time inline notification offer has already been shown on
 * this device (#53, ADR-0015): "permission asked at most twice ... plus one
 * inline offer after the first successful triage session" — never re-shown
 * once this is true, regardless of whether the User accepted or dismissed
 * it. Device-truth by definition (CONTEXT.md's Device Preference): a device
 * that already saw the offer once shouldn't see it again just because
 * another of the User's devices never has.
 */
export function readNotificationOfferShown(): boolean {
  return readStorage(NOTIFICATION_OFFER_SHOWN_KEY) === "1";
}

export function writeNotificationOfferShown(): void {
  writeStorage(NOTIFICATION_OFFER_SHOWN_KEY, "1");
}

const NOTIFICATION_OFFER_SHOWN_KEY = "mail.devicePref.notificationOfferShown";

/**
 * The Gatekeeper banner's "unseen" cursor (#56, poc-spec.md: "a
 * non-dismissible Inbox banner keys to *unseen* holds"). Per Mail Account,
 * per device — a fresh device (or a cleared one) has never viewed the
 * Screener, so the epoch default means "every current hold is unseen",
 * exactly the fresh-install behavior the banner should have.
 *
 * Not dismissible on its own: the only way to advance this cursor is
 * `writeScreenerViewed`, called when the Screener actually opens. A hold
 * that arrives after that instant (`ScreenerSenderGroup.heldSince` compares
 * later) makes the banner reappear — "unseen", not "ever seen".
 */
const SCREENER_SEEN_KEY_PREFIX = "mail.devicePref.screenerSeenUntil.";
const EPOCH = new Date(0).toISOString();

export function readScreenerSeenUntil(mailAccountId: string): string {
  return readStorage(SCREENER_SEEN_KEY_PREFIX + mailAccountId) ?? EPOCH;
}

export function writeScreenerViewed(mailAccountId: string): void {
  writeStorage(SCREENER_SEEN_KEY_PREFIX + mailAccountId, new Date().toISOString());
}

/**
 * Collapsed group state (#78, `mail#66` §"Collapse available from the armed
 * group cluster and on tap"): keyed by the group's own label ("Today", "This
 * week", a named month, …), not an id — the ladder's labels are already the
 * User-facing identity a group has (`time-groups.ts`), and what "keyed by
 * group label" in the acceptance criteria names directly. Device-local by
 * the same reasoning as the rest of this file: which groups you've folded
 * away means something different on a phone than on a laptop, so this
 * deliberately never syncs.
 *
 * Reactive since #272, but not through a per-label `use*` pair like
 * `useViewMode`/`useListDensity` above — `VirtualizedThreadList.tsx` has
 * every group's header mounted at once, keyed by a label list it doesn't
 * know ahead of a render, so a hook per label doesn't fit. Instead
 * `useGroupCollapsedVersion` below is a version counter any write bumps:
 * mounting it is what makes a write to *any* label re-render every
 * subscriber, while `readGroupCollapsed` itself stays the plain, ungated
 * read `items`'s `useMemo` already keyed off a local re-render counter —
 * only where that counter comes from moved.
 */
const GROUP_COLLAPSED_KEY_PREFIX = "mail.devicePref.groupCollapsed.";

export function readGroupCollapsed(label: string): boolean {
  return readStorage(GROUP_COLLAPSED_KEY_PREFIX + label) === "1";
}

let groupCollapsedVersion = 0;
const groupCollapsedListeners = new Set<() => void>();

/** Un-collapsing removes the key rather than writing "0" — a label with no key and one written false both read back as "not collapsed", so there's no reason to keep growing storage past what's actually folded away. */
export function writeGroupCollapsed(label: string, collapsed: boolean): void {
  if (collapsed) {
    writeStorage(GROUP_COLLAPSED_KEY_PREFIX + label, "1");
  } else {
    try {
      globalThis.localStorage?.removeItem(GROUP_COLLAPSED_KEY_PREFIX + label);
    } catch {
      // Best-effort; see module docstring.
    }
  }
  groupCollapsedVersion += 1;
  for (const listener of groupCollapsedListeners) listener();
}

function subscribeGroupCollapsed(listener: () => void): () => void {
  groupCollapsedListeners.add(listener);
  return () => groupCollapsedListeners.delete(listener);
}

/** The reactive half of the pair above — see the doc comment there. `VirtualizedThreadList.tsx` reads this once per render purely to subscribe; its return value (a version, not a label's state) exists only so `useSyncExternalStore` has something that changes to compare. */
export function useGroupCollapsedVersion(): number {
  return useSyncExternalStore(
    subscribeGroupCollapsed,
    () => groupCollapsedVersion,
    () => 0,
  );
}

/**
 * Tasks' own three Device Preferences (#256): "never synced, because a
 * Board on a laptop and a list on a phone is an honest default" — keyed per
 * **view id**, the ticket's own `today` / `upcoming` / a List's own ULID,
 * rather than one global setting, since each of those is a distinct screen
 * a User may want shown differently. All three share this file's reactive
 * `useSyncExternalStore` shape (`useViewMode`'s own pair, above) — one
 * listener `Set` per preference (not per view id: a write for any view id
 * notifies every mounted subscriber, the same low-cost "just re-check your
 * own snapshot" cost `useAccountScope`'s doc comment accepts) so two panes
 * showing the same List's Board never drift.
 *
 * Only `boardMode` is actually offered outside a Task List's own Board
 * chrome — Today/Upcoming have no Sections to be a Board's columns, so
 * `TasksApp.tsx` never renders the switch for them (#256's own acceptance
 * line) even though the key itself is addressable by their view id like the
 * other two.
 */
export type TaskBoardMode = "list" | "board";
export const DEFAULT_TASK_BOARD_MODE: TaskBoardMode = "list";

/** None (the default), by Label, or by due bucket (Overdue/Today/This week/Later/No date) — `tasks/task-board.ts#buildSwimlaneRows`'s own three shapes. */
export type TaskSwimlane = "none" | "label" | "dueBucket";
export const DEFAULT_TASK_SWIMLANE: TaskSwimlane = "none";

const BOARD_MODE_KEY_PREFIX = "tasks.devicePref.boardMode.";
const SWIMLANE_KEY_PREFIX = "tasks.devicePref.swimlane.";
const COMPLETED_OPEN_KEY_PREFIX = "tasks.devicePref.completedOpen.";

export function readTaskBoardMode(viewId: string): TaskBoardMode {
  const stored = readStorage(BOARD_MODE_KEY_PREFIX + viewId);
  return stored === "board" ? "board" : DEFAULT_TASK_BOARD_MODE;
}

const taskBoardModeListeners = new Set<() => void>();

export function writeTaskBoardMode(viewId: string, mode: TaskBoardMode): void {
  writeStorage(BOARD_MODE_KEY_PREFIX + viewId, mode);
  for (const listener of taskBoardModeListeners) listener();
}

function subscribeTaskBoardMode(listener: () => void): () => void {
  taskBoardModeListeners.add(listener);
  return () => taskBoardModeListeners.delete(listener);
}

/** Reactive pair for one view's List/Board mode — read and written by `tasks/TaskListView.tsx`'s own header toggle. */
export function useTaskBoardMode(viewId: string): [TaskBoardMode, (mode: TaskBoardMode) => void] {
  const mode = useSyncExternalStore(
    subscribeTaskBoardMode,
    () => readTaskBoardMode(viewId),
    () => DEFAULT_TASK_BOARD_MODE,
  );
  const setMode = useCallback((next: TaskBoardMode) => writeTaskBoardMode(viewId, next), [viewId]);
  return [mode, setMode];
}

export function readTaskSwimlane(viewId: string): TaskSwimlane {
  const stored = readStorage(SWIMLANE_KEY_PREFIX + viewId);
  return stored === "label" || stored === "dueBucket" ? stored : DEFAULT_TASK_SWIMLANE;
}

const taskSwimlaneListeners = new Set<() => void>();

export function writeTaskSwimlane(viewId: string, swimlane: TaskSwimlane): void {
  writeStorage(SWIMLANE_KEY_PREFIX + viewId, swimlane);
  for (const listener of taskSwimlaneListeners) listener();
}

function subscribeTaskSwimlane(listener: () => void): () => void {
  taskSwimlaneListeners.add(listener);
  return () => taskSwimlaneListeners.delete(listener);
}

/** Reactive pair for one view's swimlane grouping — read and written by `tasks/TaskBoardView.tsx`'s own header select. */
export function useTaskSwimlane(viewId: string): [TaskSwimlane, (swimlane: TaskSwimlane) => void] {
  const swimlane = useSyncExternalStore(
    subscribeTaskSwimlane,
    () => readTaskSwimlane(viewId),
    () => DEFAULT_TASK_SWIMLANE,
  );
  const setSwimlane = useCallback(
    (next: TaskSwimlane) => writeTaskSwimlane(viewId, next),
    [viewId],
  );
  return [swimlane, setSwimlane];
}

export function readTaskCompletedOpen(viewId: string): boolean {
  return readStorage(COMPLETED_OPEN_KEY_PREFIX + viewId) === "1";
}

const taskCompletedOpenListeners = new Set<() => void>();

/** Un-opening removes the key rather than writing "0" — `writeGroupCollapsed`'s own reasoning, one level up. */
export function writeTaskCompletedOpen(viewId: string, open: boolean): void {
  if (open) {
    writeStorage(COMPLETED_OPEN_KEY_PREFIX + viewId, "1");
  } else {
    try {
      globalThis.localStorage?.removeItem(COMPLETED_OPEN_KEY_PREFIX + viewId);
    } catch {
      // Best-effort; see module docstring.
    }
  }
  for (const listener of taskCompletedOpenListeners) listener();
}

function subscribeTaskCompletedOpen(listener: () => void): () => void {
  taskCompletedOpenListeners.add(listener);
  return () => taskCompletedOpenListeners.delete(listener);
}

/** Reactive pair for whether one view's "N completed" expander is open — read/written by `TaskListView.tsx`, `TaskTodayView.tsx` and `TaskUpcomingView.tsx` alike, each passing their own view id. */
export function useTaskCompletedOpen(viewId: string): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    subscribeTaskCompletedOpen,
    () => readTaskCompletedOpen(viewId),
    () => false,
  );
  const setOpen = useCallback((next: boolean) => writeTaskCompletedOpen(viewId, next), [viewId]);
  return [open, setOpen];
}

/**
 * Per-Calendar show/hide (#231's acceptance line: "per-Calendar show/hide as
 * a Device Preference"; moved onto this module in #272 — it lived as its own
 * `calendar/calendar-visibility.ts` idiom until then) — which Calendars
 * aren't shown on this device's grid, the same reasoning as view mode,
 * density and Account Scope above: which Calendars you're looking at right
 * now means something different on each device, so this deliberately never
 * syncs. Stored as the *hidden* set rather than the shown one, so a
 * newly-discovered Calendar (a fresh mirror, a newly created Local one)
 * defaults to visible without this module needing to learn about it first.
 *
 * Cached on the raw stored string the same way `readAccountScope` above is
 * — `useSyncExternalStore` needs a snapshot that's referentially stable
 * across calls when nothing changed, and a bare `JSON.parse` never gives it
 * that.
 */
const HIDDEN_CALENDARS_KEY = "calendar.devicePref.hiddenCalendarIds";

function parseHiddenCalendarIds(stored: string | null): ReadonlySet<string> {
  if (!stored) return EMPTY_CALENDAR_SET;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((entry): entry is string => typeof entry === "string"))
      : EMPTY_CALENDAR_SET;
  } catch {
    return EMPTY_CALENDAR_SET;
  }
}

const EMPTY_CALENDAR_SET: ReadonlySet<string> = new Set();

let cachedHiddenRaw: string | null | undefined;
let cachedHiddenParsed: ReadonlySet<string> = EMPTY_CALENDAR_SET;

export function readHiddenCalendarIds(): ReadonlySet<string> {
  const stored = readStorage(HIDDEN_CALENDARS_KEY);
  if (stored !== cachedHiddenRaw) {
    cachedHiddenRaw = stored;
    cachedHiddenParsed = parseHiddenCalendarIds(stored);
  }
  return cachedHiddenParsed;
}

const hiddenCalendarIdsListeners = new Set<() => void>();

export function writeHiddenCalendarIds(hidden: ReadonlySet<string>): void {
  writeStorage(HIDDEN_CALENDARS_KEY, JSON.stringify([...hidden]));
  for (const listener of hiddenCalendarIdsListeners) listener();
}

function subscribeHiddenCalendarIds(listener: () => void): () => void {
  hiddenCalendarIdsListeners.add(listener);
  return () => hiddenCalendarIdsListeners.delete(listener);
}

/** Reactive pair for the hidden-Calendar set — read by every grid view, written by `CalendarSlideOver.tsx`'s toggles. */
export function useHiddenCalendarIds(): [ReadonlySet<string>, (calendarId: string) => void] {
  const hidden = useSyncExternalStore(
    subscribeHiddenCalendarIds,
    readHiddenCalendarIds,
    () => EMPTY_CALENDAR_SET,
  );
  const toggle = useCallback((calendarId: string) => {
    const current = readHiddenCalendarIds();
    const next = new Set(current);
    if (next.has(calendarId)) next.delete(calendarId);
    else next.add(calendarId);
    writeHiddenCalendarIds(next);
  }, []);
  return [hidden, toggle];
}

/**
 * Collapsed sidebar sections (#297, `mail#294` Wave 3): every section of the
 * mail rail — Folders, Labels, and each Gmail Mail Account's own Gmail
 * Labels section — folds away independently, keyed by section id:
 * `"folders"`, `"labels"`, or `gmailLabels:<mailAccountId>` for a
 * per-account section (`Sidebar.tsx`'s own key-building). Device-local by
 * the same reasoning as the rest of this file: which sections you've folded
 * away on a phone means nothing about a desktop, so this deliberately never
 * syncs.
 *
 * Un-collapsing removes the key rather than writing "0" —
 * `writeGroupCollapsed`'s own reasoning, above. Reactive with one shared
 * listener `Set` for every key (`useTaskCompletedOpen`'s own shape): a write
 * for any section id notifies every mounted subscriber, cheap since each one
 * just re-checks its own key's snapshot.
 */
const SIDEBAR_SECTION_COLLAPSED_KEY_PREFIX = "mail.devicePref.sidebarSectionCollapsed.";

export function readSidebarSectionCollapsed(sectionId: string): boolean {
  return readStorage(SIDEBAR_SECTION_COLLAPSED_KEY_PREFIX + sectionId) === "1";
}

const sidebarSectionCollapsedListeners = new Set<() => void>();

export function writeSidebarSectionCollapsed(sectionId: string, collapsed: boolean): void {
  if (collapsed) {
    writeStorage(SIDEBAR_SECTION_COLLAPSED_KEY_PREFIX + sectionId, "1");
  } else {
    try {
      globalThis.localStorage?.removeItem(SIDEBAR_SECTION_COLLAPSED_KEY_PREFIX + sectionId);
    } catch {
      // Best-effort; see module docstring.
    }
  }
  for (const listener of sidebarSectionCollapsedListeners) listener();
}

function subscribeSidebarSectionCollapsed(listener: () => void): () => void {
  sidebarSectionCollapsedListeners.add(listener);
  return () => sidebarSectionCollapsedListeners.delete(listener);
}

/** Reactive pair for one sidebar section's collapsed state — read and written by `mail/Sidebar.tsx`'s own section headers, on desktop and the phone sheet alike. */
export function useSidebarSectionCollapsed(
  sectionId: string,
): [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribeSidebarSectionCollapsed,
    () => readSidebarSectionCollapsed(sectionId),
    () => false,
  );
  const setCollapsed = useCallback(
    (next: boolean) => writeSidebarSectionCollapsed(sectionId, next),
    [sectionId],
  );
  return [collapsed, setCollapsed];
}

/**
 * Whether due Tasks show on the Calendar's grid (#260, moved onto this
 * module in #272 — it lived as its own `calendar/calendar-task-visibility.ts`
 * idiom until then) — `readHiddenCalendarIds`'s own reasoning applied to the
 * slide-over's single "Tasks" row rather than a per-Calendar one: which
 * overlay you're looking at right now means something different on each
 * device. Stored as a plain boolean, not a hidden-set — there is exactly one
 * row to show/hide, not one per Task List (the ticket's own "Tasks are not a
 * Calendar and never get one's colour or a colour picker").
 */
const SHOW_TASKS_ON_GRID_KEY = "calendar.devicePref.showTasksOnGrid";

/** Defaults to shown — a User who has never touched the toggle sees due Tasks on the grid. */
export function readShowTasksOnGrid(): boolean {
  return readStorage(SHOW_TASKS_ON_GRID_KEY) !== "false";
}

const showTasksOnGridListeners = new Set<() => void>();

export function writeShowTasksOnGrid(show: boolean): void {
  writeStorage(SHOW_TASKS_ON_GRID_KEY, String(show));
  for (const listener of showTasksOnGridListeners) listener();
}

function subscribeShowTasksOnGrid(listener: () => void): () => void {
  showTasksOnGridListeners.add(listener);
  return () => showTasksOnGridListeners.delete(listener);
}

/** Reactive pair for the "Tasks" row's show/hide toggle. */
export function useShowTasksOnGrid(): [boolean, (show: boolean) => void] {
  const show = useSyncExternalStore(subscribeShowTasksOnGrid, readShowTasksOnGrid, () => true);
  return [show, writeShowTasksOnGrid];
}
