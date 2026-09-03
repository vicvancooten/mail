import { useCallback, useState } from "react";

/**
 * Search's own state (#51, `docs/search-ux-spec.md` §The surface) —
 * deliberately **not** a route (#71, ADR-0017): plain component state that
 * opens over whichever screen the User was on and closes back to it. The
 * app has a real router now (`router/routes.tsx`), and search was
 * consciously left out of it — see ADR-0017 for what that trades away
 * (shareable search links, back-button history across searches) and why.
 *
 * Kept as its own hook rather than folded into `useSearchState` for the
 * same reason it always was: `useSearchState` owns the parse, the prefilter
 * and the server round trip; this owns only "is the surface open, and what
 * text is in the field" — the seam a `commitQuery` vs. an `updateQuery`
 * keystroke sits at.
 */
export interface SearchOverlay {
  active: boolean;
  /** The last query text this session has seen, even while `!active` — spec: "the query survives leaving". */
  query: string;
  /** Opens the surface, pre-filled with whatever `query` last held. */
  open: () => void;
  /** Every keystroke before the next commit. */
  updateQuery: (query: string) => void;
  /** Enter or blur — a checkpoint, back when this was a route; now indistinguishable from `updateQuery`, kept as its own method so `useSearchState` doesn't need to know that changed. */
  commitQuery: (query: string) => void;
  /** `Esc` on an empty field, or the ✕ that leaves search entirely. */
  leave: () => void;
}

export function useSearchOverlay(): SearchOverlay {
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");

  const open = useCallback(() => setActive(true), []);
  const updateQuery = useCallback((next: string) => setQuery(next), []);
  const commitQuery = useCallback((next: string) => setQuery(next), []);
  const leave = useCallback(() => setActive(false), []);

  return { active, query, open, updateQuery, commitQuery, leave };
}
