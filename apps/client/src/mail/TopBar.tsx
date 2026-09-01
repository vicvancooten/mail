import type { Label, MailAccount } from "@mail/shared";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  Columns2,
  Layers,
  List as ListIcon,
  PenSquare,
  Search,
  Tag,
  X,
} from "lucide-react";
import { type RefObject, useState } from "react";
import { AccountSwitcher } from "./AccountSwitcher.js";
import type { ViewMode } from "./device-preferences.js";
import type { AdvanceDirection } from "./triage-preferences.js";

/**
 * The search field's own props (#51, `docs/search-ux-spec.md` §The
 * surface): "A search field lives in the top bar, focused by `/` or
 * `⌘K`/`Ctrl-K`." Lives here rather than in `SearchResultsView` because the
 * field itself is visible (and keeps its text) whether or not the search
 * route is currently active — only the chip row and result list are
 * search-route-only.
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

function SearchField({ search }: { search: TopBarSearch }) {
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

/**
 * The top bar: the Split/List segmented control, the Stream mode opt-in
 * toggle, the auto-advance direction toggle (#42), the filter-by-label
 * picker (#43, hidden until the account has at least one Label — no point
 * showing an empty filter), the search field (#51), and the account
 * switcher. Icons via lucide-react, icon+label buttons in the shadcn
 * convention — the commitments `prototype/triage-loop-ui` settled on (its
 * README), adopted here without pulling in the full shadcn component
 * library the real app doesn't otherwise use.
 *
 * Stream mode is deliberately not a third segmented option: it replaces
 * whichever of Split/List is showing, and that underlying choice stays
 * selectable (dimmed) so turning Stream off returns to it. Search suppresses
 * it the same way (search-ux-spec.md §The surface) — `MailSection` is what
 * enforces that, this component just keeps rendering the segmented control
 * as normal underneath.
 */
export function TopBar({
  viewMode,
  onViewMode,
  streamMode,
  onStreamMode,
  direction,
  onDirection,
  accounts,
  selectedAccountId,
  onSelectAccount,
  labels,
  labelFilter,
  onLabelFilter,
  onCompose,
  search,
}: {
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  streamMode: boolean;
  onStreamMode: (enabled: boolean) => void;
  direction: AdvanceDirection;
  onDirection: (direction: AdvanceDirection) => void;
  accounts: MailAccount[];
  selectedAccountId: string | null;
  onSelectAccount: (id: string) => void;
  /** This account's Labels (#43) — the filter-by-label picker's data source. */
  labels: Label[];
  /** `null` is the ordinary Inbox; a Label id filters to Threads carrying it. */
  labelFilter: string | null;
  onLabelFilter: (labelId: string | null) => void;
  /** Opens a new composer (#45; `c` is the same action's keyboard shortcut). */
  onCompose: () => void;
  search: TopBarSearch;
}) {
  return (
    <div className="mail-topbar">
      <div className={`segmented${streamMode || search.active ? " muted" : ""}`}>
        <button
          type="button"
          className={viewMode === "split" ? "active" : ""}
          onClick={() => onViewMode("split")}
          title="Split view"
        >
          <Columns2 size={14} /> Split
        </button>
        <button
          type="button"
          className={viewMode === "list" ? "active" : ""}
          onClick={() => onViewMode("list")}
          title="List view"
        >
          <ListIcon size={14} /> List
        </button>
      </div>

      <div className="divider" />

      <button
        type="button"
        className={`toggle${streamMode ? " on" : ""}`}
        onClick={() => onStreamMode(!streamMode)}
        title="Opt-in: replaces Split/List with one-thread-at-a-time browsing"
      >
        <Layers size={14} /> Stream mode
      </button>

      <div className="divider" />

      <button
        type="button"
        className="toggle"
        onClick={() => onDirection(direction === "older" ? "newer" : "older")}
        title="After archive/trash, which neighbor gets selected?"
      >
        {direction === "older" ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
        Next: {direction === "older" ? "Older" : "Newer"}
      </button>

      {labels.length > 0 ? (
        <>
          <div className="divider" />
          <label className="label-filter" title="Filter by label (#43)">
            <Tag size={14} />
            <select
              value={labelFilter ?? ""}
              onChange={(event) => onLabelFilter(event.target.value || null)}
              aria-label="Filter by label"
            >
              <option value="">All mail</option>
              {labels.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}

      <div className="divider" />
      <SearchField search={search} />

      <div className="topbar-spacer" />

      <button type="button" className="compose-button" onClick={onCompose} title="Compose (c)">
        <PenSquare size={14} /> Compose
      </button>

      <AccountSwitcher
        accounts={accounts}
        selectedId={selectedAccountId}
        onSelect={onSelectAccount}
      />
    </div>
  );
}
