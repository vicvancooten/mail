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
 *
 * `engaged` and `resultsView` are two separate booleans on purpose (#100):
 * typing in the Command Palette has to run the search (the prefilter, the
 * debounced server round trip) so the inline top hits can render, without
 * ever swapping the list pane into the full results view — the bug #100
 * fixed was `CommandPalette.tsx` conflating the two by calling `open()`
 * (which set both) on the very first keystroke. `active`, below, stays the
 * public name for "the results view is showing" — every existing caller
 * (`MailSection.tsx`, `TopBar.tsx`) already treated it that way; `engaged`
 * is the new, narrower flag only `useSearchState`'s own round trip and
 * `engage()`'s callers need to know about.
 */
export interface SearchOverlay {
  /** The full results view is swapped into the list pane. */
  active: boolean;
  /** A query is running (prefilter + debounced server round trip) whether or not the results view is showing — true while typing in the Palette. */
  engaged: boolean;
  /** The last query text this session has seen, even while inactive — spec: "the query survives leaving". */
  query: string;
  /** Opens the results view directly (engaging too) — the header field's own `/` fast path, and its click-to-open. */
  open: () => void;
  /** Engages the session without opening the results view — every Palette keystroke, so top hits compute while the list pane stays untouched. */
  engage: () => void;
  /** Opens the results view for an already-engaged session — the Palette's "See all results". */
  openResultsView: () => void;
  /** Every keystroke before the next commit. */
  updateQuery: (query: string) => void;
  /** Enter or blur — a checkpoint, back when this was a route; now indistinguishable from `updateQuery`, kept as its own method so `useSearchState` doesn't need to know that changed. */
  commitQuery: (query: string) => void;
  /** `Esc` on an empty field, the ✕ that leaves search entirely, or the results view's own Close. */
  leave: () => void;
}

export function useSearchOverlay(): SearchOverlay {
  const [active, setActive] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [query, setQuery] = useState("");

  const open = useCallback(() => {
    setEngaged(true);
    setActive(true);
  }, []);
  const engage = useCallback(() => setEngaged(true), []);
  const openResultsView = useCallback(() => {
    setEngaged(true);
    setActive(true);
  }, []);
  const updateQuery = useCallback((next: string) => setQuery(next), []);
  const commitQuery = useCallback((next: string) => setQuery(next), []);
  const leave = useCallback(() => {
    setActive(false);
    setEngaged(false);
  }, []);

  return { active, engaged, query, open, engage, openResultsView, updateQuery, commitQuery, leave };
}
