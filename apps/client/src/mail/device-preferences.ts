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
 */

export type ViewMode = "split" | "list";
export const DEFAULT_VIEW_MODE: ViewMode = "split";

/** The thread list's row density (#54, CONTEXT.md's Device Preference): deliberately never synced — density means something different per screen. */
export type ListDensity = "comfortable" | "compact";
export const DEFAULT_LIST_DENSITY: ListDensity = "comfortable";

const VIEW_MODE_KEY = "mail.devicePref.viewMode";
const STREAM_MODE_KEY = "mail.devicePref.streamMode";
const LAST_ACCOUNT_KEY = "mail.devicePref.lastAccountId";
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

export function writeViewMode(mode: ViewMode): void {
  writeStorage(VIEW_MODE_KEY, mode);
}

export function readListDensity(): ListDensity {
  const stored = readStorage(LIST_DENSITY_KEY);
  return stored === "comfortable" || stored === "compact" ? stored : DEFAULT_LIST_DENSITY;
}

export function writeListDensity(density: ListDensity): void {
  writeStorage(LIST_DENSITY_KEY, density);
}

export function readStreamMode(): boolean {
  return readStorage(STREAM_MODE_KEY) === "1";
}

export function writeStreamMode(enabled: boolean): void {
  writeStorage(STREAM_MODE_KEY, enabled ? "1" : "0");
}

export function readLastAccountId(): string | null {
  return readStorage(LAST_ACCOUNT_KEY);
}

export function writeLastAccountId(id: string): void {
  writeStorage(LAST_ACCOUNT_KEY, id);
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
