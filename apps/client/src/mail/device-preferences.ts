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

const VIEW_MODE_KEY = "mail.devicePref.viewMode";
const STREAM_MODE_KEY = "mail.devicePref.streamMode";
const LAST_ACCOUNT_KEY = "mail.devicePref.lastAccountId";
const OPEN_COMPOSER_KEY = "mail.devicePref.openComposerId";

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
