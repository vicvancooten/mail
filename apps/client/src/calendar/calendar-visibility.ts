/**
 * Per-Calendar show/hide (#231's acceptance line: "per-Calendar show/hide as
 * a Device Preference") — which Calendars aren't shown on this device's
 * grid, the same reasoning `mail/device-preferences.ts` already gives view
 * mode, density and Account Scope: which Calendars you're looking at right
 * now means something different on each device, so this deliberately never
 * syncs. Stored as the *hidden* set rather than the shown one, so a
 * newly-discovered Calendar (a fresh mirror, a newly created Local one)
 * defaults to visible without this module needing to learn about it first.
 *
 * Same `useSyncExternalStore` shape as `mail/device-preferences.ts` — a
 * toggle from the slide-over (`CalendarSlideOver.tsx`) reaches every mounted
 * grid the same instant, not just the panel that wrote it.
 */
import { useCallback, useSyncExternalStore } from "react";

const HIDDEN_CALENDARS_KEY = "calendar.devicePref.hiddenCalendarIds";

function readStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(HIDDEN_CALENDARS_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    globalThis.localStorage?.setItem(HIDDEN_CALENDARS_KEY, value);
  } catch {
    // Best-effort; a lost preference just falls back to "every Calendar shown".
  }
}

function parseHidden(stored: string | null): ReadonlySet<string> {
  if (!stored) return EMPTY_SET;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((entry): entry is string => typeof entry === "string"))
      : EMPTY_SET;
  } catch {
    return EMPTY_SET;
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

let cachedRaw: string | null | undefined;
let cachedParsed: ReadonlySet<string> = EMPTY_SET;

export function readHiddenCalendarIds(): ReadonlySet<string> {
  const stored = readStorage();
  if (stored !== cachedRaw) {
    cachedRaw = stored;
    cachedParsed = parseHidden(stored);
  }
  return cachedParsed;
}

const listeners = new Set<() => void>();

export function writeHiddenCalendarIds(hidden: ReadonlySet<string>): void {
  writeStorage(JSON.stringify([...hidden]));
  for (const listener of listeners) listener();
}

function subscribeHiddenCalendarIds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive pair for the hidden-Calendar set — read by every grid view, written by `CalendarSlideOver.tsx`'s toggles. */
export function useHiddenCalendarIds(): [ReadonlySet<string>, (calendarId: string) => void] {
  const hidden = useSyncExternalStore(
    subscribeHiddenCalendarIds,
    readHiddenCalendarIds,
    () => EMPTY_SET,
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
