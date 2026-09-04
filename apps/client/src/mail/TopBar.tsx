import type { Label, MailAccount } from "@mail/shared";
import { Clock, Layers, Search, ShieldAlert, X } from "lucide-react";
import { type RefObject, useState } from "react";
import { AccountScope } from "./AccountScope.js";
import type { AccountScope as AccountScopeIds } from "./device-preferences.js";

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
 * Mail's own toolbar — the view controls that belong to this App rather than
 * to the Client's chrome: the Stream mode opt-in, the filter-by-label picker
 * (#43, hidden until the account has at least one Label), Mail's search
 * field (#51), the Screener entry (#56) and Account Scope (#73,
 * `AccountScope.tsx`).
 *
 * Rebuilt in #86. The comp
 * (`docs/design/prototypes/the-instrument.html`) puts only four things in
 * the global header — App Switcher, one centred search entry, appearance,
 * avatar — and renders none of the controls above, because its mock has one
 * view mode and one account. So these live in a second, quieter bar under
 * the header rather than jammed into the top rail, and they take the comp's
 * *control* language rather than the old segmented-plate one: `--radius-md`
 * icon buttons, transparent at rest, `--color-hover` under the pointer and
 * `--color-accent-soft` with accent ink when they carry the current state.
 * No inverted-ink compartments, no uppercase letterspaced plates, no
 * hairline dividers between them — the bar reads as chrome, not as a run of
 * joinery.
 *
 * Split/List, row density and the auto-advance direction moved into
 * Settings (#99, "every former toolbar toggle has exactly one home"): Split/
 * List and density are now `settings/ThisDeviceSection.tsx`'s Device
 * Preferences, direction is `settings/GeneralSection.tsx`'s synced
 * `Preference` — this toolbar no longer renders any of the three. Stream
 * (#105, CONTEXT.md) isn't a toggle any more either — it's `onOpenStream`,
 * a plain navigation to its own full-screen route, entered deliberately
 * rather than switched into.
 *
 * Compose is not here: the comp's Compose is the accent pill at the top of
 * the folder rail, and that is where `Sidebar.tsx` renders it. Nor is a
 * folder legend — the rail's current entry already names the folder, and
 * Account Scope's own avatars name the account.
 *
 * Every icon-only control keeps a text accessible name matching what it used
 * to say in words ("Stream mode"), so it is still nameable by voice, by
 * screen reader and by test.
 */
export function TopBar({
  onOpenStream,
  accounts,
  accountScope,
  onAccountScopeChange,
  labels,
  labelFilter,
  onLabelFilter,
  screener,
  search,
}: {
  /** Stream's own entry point (#105) — a plain navigation, run through the Action registry's `open-stream` (`MailSection.tsx`'s own `onOpenStream`). */
  onOpenStream: () => void;
  accounts: MailAccount[];
  /** Account Scope (#73): which Mail Accounts the Thread list draws from. */
  accountScope: AccountScopeIds;
  onAccountScopeChange: (ids: AccountScopeIds) => void;
  /** The primary in-scope account's Labels (#43) — the filter-by-label picker's data source. */
  labels: Label[];
  /** `null` is the ordinary Inbox; a Label id filters to Threads carrying it. */
  labelFilter: string | null;
  onLabelFilter: (labelId: string | null) => void;
  /** The Screener entry point (#56): hidden while there is nothing held, same "hidden until it has something to show" as the label picker above. */
  screener: { count: number; onOpen: () => void };
  search: TopBarSearch;
}) {
  return (
    <div className="mail-toolbar">
      <button
        type="button"
        className="toolbar-btn"
        onClick={onOpenStream}
        aria-label="Open Stream"
        title="Stream — process the Inbox one Thread at a time, full screen"
      >
        <Layers size={15} />
      </button>

      {labels.length > 0 ? (
        <select
          className="toolbar-select"
          value={labelFilter ?? ""}
          onChange={(event) => onLabelFilter(event.target.value || null)}
          aria-label="Filter by label"
          title="Filter by label"
        >
          <option value="">All mail</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      ) : null}

      {screener.count > 0 ? (
        /* The one place `--color-warn` reaches the triage screen: a soft
           chip rather than an outlined plate, so it reads as a count worth
           a click and not as an alert bar. */
        <button type="button" className="screener-chip" onClick={screener.onOpen}>
          <ShieldAlert size={14} />
          {screener.count} held
        </button>
      ) : null}

      <div className="toolbar-spacer" />

      <SearchField search={search} />
      <AccountScope accounts={accounts} scope={accountScope} onChange={onAccountScopeChange} />
    </div>
  );
}
