/**
 * View mode, Stream mode, and last-active Mail Account are all **Device
 * Preferences** (CONTEXT.md): they deliberately never sync, because they
 * mean something different on each device. #54 builds the formal Device
 * Preferences seam; until then this is a plain `localStorage` stand-in —
 * still device-local, still never synced, just not routed through a
 * settings collection yet.
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
 */

import { useCallback, useSyncExternalStore } from "react";

export type ViewMode = "split" | "list";
export const DEFAULT_VIEW_MODE: ViewMode = "split";

/** The thread list's row density (#54, CONTEXT.md's Device Preference): deliberately never synced — density means something different per screen. */
export type ListDensity = "comfortable" | "compact";
export const DEFAULT_LIST_DENSITY: ListDensity = "comfortable";

const VIEW_MODE_KEY = "mail.devicePref.viewMode";
const STREAM_MODE_KEY = "mail.devicePref.streamMode";
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

export function readStreamMode(): boolean {
  return readStorage(STREAM_MODE_KEY) === "1";
}

export function writeStreamMode(enabled: boolean): void {
  writeStorage(STREAM_MODE_KEY, enabled ? "1" : "0");
}

/**
 * Account Scope (#73, `mail#66` §"Account Scope in the Client's own chrome"):
 * which of the User's Mail Accounts the Thread list draws from — Client-level
 * chrome rather than Mail-level, "because narrowing to one account is a
 * question every App answers". Device-local by the same reasoning as the
 * rest of this file: which accounts you're looking at right now means
 * something different on each device. Supersedes the single
 * `mail.devicePref.lastAccountId` key this replaces — a device upgrading
 * from that key simply falls back to "all accounts" once, the same default
 * a first-ever device gets.
 *
 * Stored as an id array rather than a set — order carries no meaning of its
 * own (`resolveAccountScope` below is what a caller reads back), but a plain
 * JSON array is the simplest thing that survives `JSON.stringify`/`parse`.
 */
export type AccountScope = readonly string[];

const ACCOUNT_SCOPE_KEY = "mail.devicePref.accountScope";

/** The stored Scope verbatim, or `null` if never set or unreadable — callers resolve that against the live account list (`resolveAccountScope`), never render it directly. */
export function readAccountScope(): AccountScope | null {
  const stored = readStorage(ACCOUNT_SCOPE_KEY);
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.every((entry): entry is string => typeof entry === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** Scope "cannot be emptied" (#73's acceptance criteria) — a no-op guard here too, so a caller that skips the UI-level guard can't wipe a device's Scope preference by accident. */
export function writeAccountScope(accountIds: AccountScope): void {
  if (accountIds.length === 0) return;
  writeStorage(ACCOUNT_SCOPE_KEY, JSON.stringify(accountIds));
}

/**
 * The stored Scope narrowed to Mail Accounts that still exist, falling back
 * to "every account" — the documented default — the moment that narrowing
 * (or a never-set/corrupt read) would otherwise leave nothing selected.
 * Order follows `accounts` (created-at, per `useMailAccounts`' own doc
 * comment), not the stored array, so a scope read back after an account was
 * removed and re-added doesn't strand it out of its usual place.
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
 */
const GROUP_COLLAPSED_KEY_PREFIX = "mail.devicePref.groupCollapsed.";

export function readGroupCollapsed(label: string): boolean {
  return readStorage(GROUP_COLLAPSED_KEY_PREFIX + label) === "1";
}

/** Un-collapsing removes the key rather than writing "0" — a label with no key and one written false both read back as "not collapsed", so there's no reason to keep growing storage past what's actually folded away. */
export function writeGroupCollapsed(label: string, collapsed: boolean): void {
  if (collapsed) {
    writeStorage(GROUP_COLLAPSED_KEY_PREFIX + label, "1");
    return;
  }
  try {
    globalThis.localStorage?.removeItem(GROUP_COLLAPSED_KEY_PREFIX + label);
  } catch {
    // Best-effort; see module docstring.
  }
}
