import { useCallback, useEffect, useRef, useState } from "react";

/**
 * `/search?q=<raw query>` as a real route (#51, `docs/search-ux-spec.md`
 * §The surface / §When a search runs). This app has no router — every other
 * screen lives at `/` — so `/search` is the one pathname this hook owns,
 * driven off plain `history.pushState`/`replaceState` plus a `popstate`
 * listener, exactly the way the spec describes the URL behaving:
 *
 * - **Replaced while typing, pushed on commit** (Enter or blur), "so the
 *   back button walks committed searches rather than eleven half-typed
 *   ones." The first keystroke of a fresh search session — or opening with
 *   a query already in hand (`/` reopening the last one) — is the one push
 *   that seals the pre-search state as its own history entry; every
 *   keystroke after that replaces it until the next commit pushes a new
 *   checkpoint.
 * - **Browser back leaves in one press**: since entering only ever pushes
 *   once per session (not once per keystroke), a single `history.back()`
 *   — real or simulated by `leave()` for `Esc` on an empty field — always
 *   lands back on the pre-search entry.
 */

function currentRoute(): { active: boolean; query: string } {
  if (typeof location === "undefined") return { active: false, query: "" };
  return {
    active: location.pathname === "/search",
    query: new URLSearchParams(location.search).get("q") ?? "",
  };
}

function searchUrl(query: string): string {
  return query.length > 0 ? `/search?q=${encodeURIComponent(query)}` : "/search";
}

export interface UseSearchRoute {
  active: boolean;
  /** The last query this session has seen, even while `!active` — spec: "the query survives leaving". */
  query: string;
  /** Enters `/search`, pre-filled with whatever `query` last held (or `seed` on a first-ever open). */
  open: () => void;
  /** Replaces the current URL with the in-progress text — every keystroke before the next commit. */
  updateQuery: (query: string) => void;
  /** Pushes a checkpoint entry — Enter or blur. */
  commitQuery: (query: string) => void;
  /** One simulated Back press — `Esc` on an empty field, or the ✕ that leaves search entirely. */
  leave: () => void;
}

export function useSearchRoute(): UseSearchRoute {
  const [route, setRoute] = useState(currentRoute);
  const enteredRef = useRef(route.active);
  /** True only once *this hook* has pushed the pre-search checkpoint entry — never on a deep-linked `/search?q=` boot, which has no such entry to `back()` to. */
  const pushedOwnEntryRef = useRef(false);

  useEffect(() => {
    function onPopState() {
      const next = currentRoute();
      setRoute(next);
      enteredRef.current = next.active;
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const open = useCallback(() => {
    history.pushState(null, "", searchUrl(route.query));
    enteredRef.current = true;
    pushedOwnEntryRef.current = true;
    setRoute({ active: true, query: route.query });
  }, [route.query]);

  const updateQuery = useCallback((query: string) => {
    if (enteredRef.current) {
      history.replaceState(null, "", searchUrl(query));
    } else {
      history.pushState(null, "", searchUrl(query));
      enteredRef.current = true;
      pushedOwnEntryRef.current = true;
    }
    setRoute({ active: true, query });
  }, []);

  const commitQuery = useCallback((query: string) => {
    history.pushState(null, "", searchUrl(query));
    enteredRef.current = true;
    pushedOwnEntryRef.current = true;
    setRoute({ active: true, query });
  }, []);

  /**
   * A real Back press when this hook is the one that pushed the checkpoint
   * entry; otherwise (a deep-linked `/search?q=` boot, with nothing of ours
   * on the stack to return to) falls back to replacing the URL with `/` —
   * still "leaves in one press", just without a history entry to spend.
   */
  const leave = useCallback(() => {
    if (pushedOwnEntryRef.current) {
      history.back();
      return;
    }
    history.replaceState(null, "", "/");
    setRoute((current) => ({ active: false, query: current.query }));
  }, []);

  return { active: route.active, query: route.query, open, updateQuery, commitQuery, leave };
}
