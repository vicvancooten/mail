import type { AutoAdvanceDirection, Label, MailAccount } from "@mail/shared";
import { type RefObject, useState } from "react";
import { Pictogram } from "../brand/Pictogram.js";
import { AccountScope } from "./AccountScope.js";
import type {
  AccountScope as AccountScopeIds,
  ListDensity,
  ViewMode,
} from "./device-preferences.js";

/**
 * The search field's own props (#51, `docs/search-ux-spec.md` §The
 * surface): "A search field lives in the top bar, focused by `/`." Lives
 * here rather than in `SearchResultsView` because the field itself is
 * visible (and keeps its text) whether or not the search route is currently
 * active — only the chip row and result list are search-route-only.
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

function SearchField({ search }: { search: TopBarSearch }) {
  const [focused, setFocused] = useState(false);
  const showRecent = focused && search.queryText.length === 0 && search.recentSearches.length > 0;

  return (
    <div className="mail-search-field">
      <Pictogram name="search" size={14} className="mail-search-icon" />
      <input
        ref={search.inputRef}
        type="text"
        placeholder="Search mail… (/, ⌘K)"
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
          <Pictogram name="close" size={13} />
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
              <Pictogram name="snooze" size={12} /> {query}
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
 * showing an empty filter), the search field (#51), and the Account Scope
 * control (#73, `AccountScope.tsx`) right beside it — Client-level chrome
 * rather than a Mail-level pick, per the parent ticket (#66). Icons are
 * Wicket pictograms (`brand/Pictogram.tsx`), icon+label buttons in the shadcn
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
  density,
  onDensity,
  direction,
  onDirection,
  accounts,
  accountScope,
  onAccountScopeChange,
  labels,
  labelFilter,
  onLabelFilter,
  onCompose,
  screener,
  search,
}: {
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  streamMode: boolean;
  onStreamMode: (enabled: boolean) => void;
  /** The thread list's row density (#54, Device Preference — never synced). */
  density: ListDensity;
  onDensity: (density: ListDensity) => void;
  direction: AutoAdvanceDirection;
  onDirection: (direction: AutoAdvanceDirection) => void;
  accounts: MailAccount[];
  /** Account Scope (#73): which Mail Accounts the Thread list draws from. */
  accountScope: AccountScopeIds;
  onAccountScopeChange: (ids: AccountScopeIds) => void;
  /** The primary in-scope account's Labels (#43) — the filter-by-label picker's data source. */
  labels: Label[];
  /** `null` is the ordinary Inbox; a Label id filters to Threads carrying it. */
  labelFilter: string | null;
  onLabelFilter: (labelId: string | null) => void;
  /** Opens a new composer (#45; `c` is the same action's keyboard shortcut). */
  onCompose: () => void;
  /** The Screener entry point (#56): hidden while there is nothing held, same "hidden until it has something to show" as the label picker above. */
  screener: { count: number; onOpen: () => void };
  search: TopBarSearch;
}) {
  // The legend's account label (#40) only still means one thing when Scope
  // has narrowed to exactly one account — with several in Scope, the
  // Account Scope control's own stacked avatars say which, not this line.
  const account =
    accountScope.length === 1
      ? (accounts.find((candidate) => candidate.id === accountScope[0]) ?? null)
      : null;
  const activeLabel = labelFilter ? labels.find((l) => l.id === labelFilter) : null;

  return (
    <div className="mail-topbar">
      {/* The tray label: a compartment says what is filed in it. Without this
          nothing on the triage screen names the Folder or the Mail Account. */}
      <p className="mail-legend">
        <span className="mail-legend-folder">{activeLabel ? activeLabel.name : "Inbox"}</span>
        {account ? <span className="mail-legend-account">{account.emailAddress}</span> : null}
      </p>

      <div className="divider" />

      <div className={`segmented${streamMode || search.active ? " muted" : ""}`}>
        <button
          type="button"
          className={viewMode === "split" ? "active" : ""}
          onClick={() => onViewMode("split")}
          title="Split view"
        >
          <Pictogram name="split" size={14} /> Split
        </button>
        <button
          type="button"
          className={viewMode === "list" ? "active" : ""}
          onClick={() => onViewMode("list")}
          title="List view"
        >
          <Pictogram name="rows" size={14} /> List
        </button>
      </div>

      <div className="divider" />

      <button
        type="button"
        className={`toggle${streamMode ? " on" : ""}`}
        onClick={() => onStreamMode(!streamMode)}
        title="Opt-in: replaces Split/List with one-thread-at-a-time browsing"
      >
        <Pictogram name="stream" size={14} /> Stream mode
      </button>

      <div className="divider" />

      <button
        type="button"
        className={`toggle${density === "compact" ? " on" : ""}`}
        onClick={() => onDensity(density === "compact" ? "comfortable" : "compact")}
        title="Thread list row density — this device only"
      >
        <Pictogram name="rows" size={14} /> {density === "compact" ? "Compact" : "Comfortable"}
      </button>

      <div className="divider" />

      <button
        type="button"
        className="toggle"
        onClick={() => onDirection(direction === "older" ? "newer" : "older")}
        title="After archive/trash, which neighbor gets selected?"
      >
        {direction === "older" ? (
          <Pictogram name="arrow-down" size={14} />
        ) : (
          <Pictogram name="arrow-up" size={14} />
        )}
        Next: {direction === "older" ? "Older" : "Newer"}
      </button>

      {labels.length > 0 ? (
        <>
          <div className="divider" />
          <label className="label-filter" title="Filter by label (#43)">
            <Pictogram name="label" size={14} />
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

      {screener.count > 0 ? (
        <>
          <div className="divider" />
          {/* The held plate: `--w-fluor` is reserved for this one state, and
              this is the only place it reaches the triage screen. */}
          <button
            type="button"
            className="held-plate screener-entry"
            data-count={screener.count}
            onClick={screener.onOpen}
          >
            <Pictogram name="held" size={13} /> {screener.count} held
          </button>
        </>
      ) : null}

      <div className="divider" />
      <SearchField search={search} />
      <AccountScope accounts={accounts} scope={accountScope} onChange={onAccountScopeChange} />

      <div className="topbar-spacer" />

      <button type="button" className="compose-button" onClick={onCompose} title="Compose (c)">
        <Pictogram name="pen-square" size={14} /> Compose
      </button>
    </div>
  );
}
