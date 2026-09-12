import { vi } from "vitest";

/**
 * jsdom has no `matchMedia` at all (`hooks/use-phone-width.ts`'s own doc
 * comment), so any `matchMedia`-driven hook (`hooks/use-phone-width.ts`,
 * `theme/device-theme.ts`'s system-dark read) needs one stubbed in to run
 * under a test. This fakes just enough of `MediaQueryList` for either: a
 * `matches` flag per query, and `addEventListener`/`removeEventListener`
 * for `"change"` so a test can simulate a resize via the returned
 * `setMatches`.
 */
export function stubMatchMedia(initialMatches: (query: string) => boolean) {
  const listenersByQuery = new Map<string, Set<(event: { matches: boolean }) => void>>();
  const matchesByQuery = new Map<string, boolean>();

  function currentMatches(query: string): boolean {
    let matches = matchesByQuery.get(query);
    if (matches === undefined) {
      matches = initialMatches(query);
      matchesByQuery.set(query, matches);
    }
    return matches;
  }

  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      let listeners = listenersByQuery.get(query);
      if (!listeners) {
        listeners = new Set();
        listenersByQuery.set(query, listeners);
      }
      const mql = {
        media: query,
        get matches() {
          return currentMatches(query);
        },
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          listeners.delete(listener);
        },
        addListener: (listener: (event: { matches: boolean }) => void) => listeners.add(listener),
        removeListener: (listener: (event: { matches: boolean }) => void) =>
          listeners.delete(listener),
        dispatchEvent: () => true,
        onchange: null,
      };
      return mql;
    }),
  );

  return {
    /** Fires a synthetic `"change"` at every listener registered for `query`, with the new `matches` value. */
    setMatches(query: string, matches: boolean) {
      matchesByQuery.set(query, matches);
      for (const listener of listenersByQuery.get(query) ?? []) {
        listener({ matches });
      }
    },
  };
}
