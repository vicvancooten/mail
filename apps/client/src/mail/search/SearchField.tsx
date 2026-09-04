import { Clock, Search, X } from "lucide-react";
import { type RefObject, useState } from "react";

/**
 * The search field's own props (#51, `docs/search-ux-spec.md` §The
 * surface): "A search field lives in the top bar, focused by `/`." Extracted
 * from `mail/TopBar.tsx` in #96, which removed that toolbar entirely — the
 * field itself is Mail's own (the Hub's own search entry,
 * `router/RootLayout.tsx`'s `global-search` button, stays a plain Palette
 * trigger for every route; this is the real, always-visible query field
 * `docs/search-ux-spec.md` describes, with its `/` fast path and recent
 * searches, which only Mail has a use for). Lives in its own file rather
 * than inline in `MailSection.tsx` because the field itself is visible (and
 * keeps its text) whether or not the search route is currently active —
 * only the chip row and result list are search-route-only.
 *
 * `onOpen` fires on focus (`/`, or a real click/tap) — `MailSection.tsx`
 * decides what that means: the pre-#79 "just activate search" path for `/`,
 * or opening the Command Palette for a click, its other entry point
 * (#79, `command-palette/CommandPalette.tsx`).
 */
export interface TopBarSearch {
  active: boolean;
  queryText: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (text: string) => void;
  onCommit: (text: string) => void;
  onEsc: () => void;
  onBackspaceEmpty: () => void;
  onOpen: () => void;
  recentSearches: readonly string[];
  onRunRecent: (query: string) => void;
  onClearRecent: () => void;
}

export function SearchField({ search }: { search: TopBarSearch }) {
  const [focused, setFocused] = useState(false);
  const showRecent = focused && search.queryText.length === 0 && search.recentSearches.length > 0;

  return (
    <div className="mail-search-field">
      <Search size={14} className="mail-search-icon" />
      <input
        ref={search.inputRef}
        type="text"
        placeholder="Search mail… (/)"
        aria-label="Search mail"
        value={search.queryText}
        onFocus={() => {
          setFocused(true);
          if (!search.active) search.onOpen();
        }}
        onBlur={() => {
          setFocused(false);
          if (search.active) search.onCommit(search.queryText);
        }}
        onChange={(event) => search.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            search.onCommit(search.queryText);
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            const leavingEmpty = search.queryText.length === 0;
            search.onEsc();
            // "Esc on an empty field leaves search" (search-ux-spec.md) —
            // leaving should give focus back to the list it restores, not
            // leave it stuck in a field that's no longer showing results.
            if (leavingEmpty) (event.target as HTMLInputElement).blur();
          } else if (event.key === "Backspace" && search.queryText.length === 0) {
            search.onBackspaceEmpty();
          }
        }}
      />
      {search.queryText.length > 0 ? (
        <button
          type="button"
          className="mail-search-clear"
          title="Clear"
          onClick={() => search.onChange("")}
        >
          <X size={13} />
        </button>
      ) : null}
      {showRecent ? (
        <div className="mail-search-recent" role="listbox" aria-label="Recent searches">
          {search.recentSearches.map((query) => (
            <button
              type="button"
              key={query}
              className="mail-search-recent-item"
              // `onMouseDown` (not `onClick`): fires before the input's own
              // `onBlur`, so the click lands before blur would otherwise
              // commit whatever stale text was in the field.
              onMouseDown={(event) => {
                event.preventDefault();
                search.onRunRecent(query);
              }}
            >
              <Clock size={12} /> {query}
            </button>
          ))}
          <button
            type="button"
            className="mail-search-recent-clear"
            onMouseDown={(event) => {
              event.preventDefault();
              search.onClearRecent();
            }}
          >
            Clear recent searches
          </button>
        </div>
      ) : null}
    </div>
  );
}
