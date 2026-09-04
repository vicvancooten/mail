import type { MailAccount } from "@mail/shared";
import { Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CachedThread } from "../../store/index.js";
import { useThreadMessages } from "../reading/useThreadMessages.js";
import type { ViewOrigin } from "../search/scope.js";
import { formatIndexWatermark, type SearchState } from "../search/useSearchState.js";
import type { OnReply } from "../ThreadDetailPane.js";
import type { Triage } from "../useTriage.js";
import { buildCommands, type PaletteCommand } from "./commands.js";

/** A palette row is either a Command or a mail hit — one flat, keyboard-navigable list (#79's "keyboard-complete"). */
type PaletteRow =
  | { kind: "command"; command: PaletteCommand }
  | { kind: "hit"; thread: CachedThread }
  | { kind: "see-all"; count: number };

function matchesQuery(command: PaletteCommand, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    command.label.toLowerCase().includes(needle) ||
    (command.shortcut?.toLowerCase().includes(needle) ?? false)
  );
}

function rowDomId(index: number): string {
  return `command-palette-row-${index}`;
}

/**
 * `⌘K`/`Ctrl-K` and the header search field's other entry point (#79): the
 * Client's discoverability surface — "every command listed with its
 * binding, grouped by section, and unbound commands too" — and, once the
 * User types, the same mail search the header field always ran (the 3-
 * character floor, the ~200ms debounce, the Local Cache prefilter — all of
 * it lives in `useSearchState`, passed in as `search` rather than
 * duplicated here).
 *
 * Deliberately reuses `search` wholesale rather than a second search
 * pipeline: typing here calls `search.onFieldChange` exactly like the top
 * bar field does, which is what activates `search.active` and, with it,
 * `MailSection`'s own `<SearchResultsView>` swap underneath this overlay —
 * "the list pane behind the palette" is already live by the time "See all
 * results" is reached; this overlay just stops covering it. Committing (via
 * "See all results", or Enter on a hit) calls `search.onCommit`, the same
 * "Enter commits" contract the header field keeps.
 *
 * Keyboard nav is a flat list, not a real DOM focus walk: the input keeps
 * focus throughout (typing never has to fight losing/regaining it), and
 * `activeIndex` alone tracks which row Up/Down/Enter act on —
 * `aria-activedescendant` is what makes that legible to a screen reader.
 */
export function CommandPalette({
  open,
  onClose,
  selectedThread,
  triage,
  onReply,
  onCompose,
  onBackToList,
  onOpenScreener,
  screenerCount,
  onFocusSearch,
  onOpenShortcutSheet,
  search,
  searchOrigin,
  accounts,
  accountScope,
}: {
  open: boolean;
  onClose: () => void;
  selectedThread: CachedThread | null;
  triage: Triage;
  onReply: OnReply;
  onCompose: () => void;
  onBackToList: () => void;
  onOpenScreener: () => void;
  screenerCount: number;
  onFocusSearch: () => void;
  onOpenShortcutSheet: () => void;
  search: SearchState;
  searchOrigin: ViewOrigin;
  accounts: readonly MailAccount[];
  /** Which Mail Account a hit came from is only worth naming once a search actually spans more than one (#80, same "several are in Scope" gate `SearchResultsView`'s own row badge uses). */
  accountScope: readonly string[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Rules of Hooks: called unconditionally even with nothing selected —
  // `useThreadMessages("")`'s own doc comment is what makes that a no-op.
  const { messages } = useThreadMessages(selectedThread?.id ?? "");
  const latestMessage = messages?.at(-1) ?? null;

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setActiveIndex(0);
    }
  }, [open]);

  const query = search.queryText;

  const commands = useMemo(
    () =>
      buildCommands({
        selectedThread,
        triage,
        latestMessage,
        onReply,
        onCompose,
        onBackToList,
        onOpenScreener,
        screenerCount,
        onFocusSearch,
        onOpenShortcutSheet,
      }),
    [
      selectedThread,
      triage,
      latestMessage,
      onReply,
      onCompose,
      onBackToList,
      onOpenScreener,
      screenerCount,
      onFocusSearch,
      onOpenShortcutSheet,
    ],
  );

  const matchedCommands = useMemo(
    () => commands.filter((command) => matchesQuery(command, query)),
    [commands, query],
  );

  // Top hits (#79's "shows the top hits inline"): only once the floor is
  // met — below it `search.results` is whatever the *previous* query left
  // behind (`useSearchState`'s own overlay), which would otherwise flash
  // stale hits under an unrelated command search.
  const showHits = query.trim().length > 0 && search.meetsFloor;
  const hits = showHits ? search.results.slice(0, 5) : [];
  const showAccountBadge = accountScope.length > 1;

  const rows: PaletteRow[] = useMemo(
    () => [
      ...matchedCommands.map((command): PaletteRow => ({ kind: "command", command })),
      ...hits.map((thread): PaletteRow => ({ kind: "hit", thread })),
      ...(showHits ? [{ kind: "see-all" as const, count: search.results.length }] : []),
    ],
    [matchedCommands, hits, showHits, search.results.length],
  );

  // Clamp rather than reset on every keystroke — losing the highlight each
  // time a character lands would make Down-arrow-then-type unusable.
  const activeRowIndex = rows.length === 0 ? -1 : Math.min(activeIndex, rows.length - 1);

  function runRow(row: PaletteRow) {
    if (row.kind === "command") {
      if (!row.command.run) return;
      row.command.run();
      onClose();
      return;
    }
    if (row.kind === "hit") {
      search.select(row.thread.id);
      onClose();
      return;
    }
    search.onCommit(query);
    onClose();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = activeRowIndex >= 0 ? rows[activeRowIndex] : undefined;
      if (row) runRow(row);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query.length > 0) {
        search.onFieldChange("");
      } else {
        search.onEsc();
        onClose();
      }
    }
  }

  if (!open) return null;

  const watermark = showHits ? formatIndexWatermark(search.indexWatermark) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-dismiss is a mouse convenience layered on an already-accessible dialog — Escape and the Close button (both real, focusable controls below) are the keyboard/screen-reader paths.
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="command-palette-input-row">
          <Search size={15} className="command-palette-icon" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={activeRowIndex >= 0 ? rowDomId(activeRowIndex) : undefined}
            aria-autocomplete="list"
            aria-label="Search commands and mail"
            placeholder="Search commands or mail…"
            value={query}
            onChange={(event) => {
              if (!search.active) search.open(searchOrigin);
              search.onFieldChange(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
          <button
            type="button"
            className="command-palette-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div
          id="command-palette-list"
          role="listbox"
          aria-label="Commands and mail"
          className="command-palette-list"
        >
          {rows.length === 0 ? (
            <p className="command-palette-empty">No matching commands.</p>
          ) : null}

          {matchedCommands.length > 0 ? (
            <div className="command-palette-section">
              <p className="command-palette-section-label">Commands</p>
              {matchedCommands.map((command, offset) => {
                const index = offset;
                const disabled = !command.run || Boolean(command.disabledReason);
                return (
                  <button
                    type="button"
                    key={command.id}
                    id={rowDomId(index)}
                    role="option"
                    aria-selected={index === activeRowIndex}
                    aria-disabled={disabled}
                    className={`command-palette-row${index === activeRowIndex ? " active" : ""}${disabled ? " disabled" : ""}`}
                    title={command.disabledReason}
                    disabled={!command.run}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runRow({ kind: "command", command })}
                  >
                    <span className="command-palette-row-section">{command.section}</span>
                    <span className="command-palette-row-label">{command.label}</span>
                    {command.shortcut ? (
                      <kbd className="keycap">{command.shortcut}</kbd>
                    ) : (
                      <span className="command-palette-unbound">unbound</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}

          {hits.length > 0 ? (
            <div className="command-palette-section">
              <p className="command-palette-section-label">Mail</p>
              {hits.map((thread, offset) => {
                const index = matchedCommands.length + offset;
                const display = search.displayById.get(thread.id);
                const participants =
                  thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)";
                const accountLabel = showAccountBadge
                  ? accounts.find((candidate) => candidate.id === thread.mailAccountId)
                      ?.emailAddress
                  : null;
                return (
                  <button
                    type="button"
                    key={thread.id}
                    id={rowDomId(index)}
                    role="option"
                    aria-selected={index === activeRowIndex}
                    className={`command-palette-row${index === activeRowIndex ? " active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runRow({ kind: "hit", thread })}
                  >
                    <span className="command-palette-hit-subject">
                      {thread.subject || "(no subject)"}
                    </span>
                    <span className="command-palette-hit-from">{participants}</span>
                    {accountLabel ? (
                      <span className="command-palette-hit-account">{accountLabel}</span>
                    ) : null}
                    {display?.gatekeeper ? (
                      <span className="command-palette-hit-badge">{display.gatekeeper}</span>
                    ) : null}
                  </button>
                );
              })}
              {(() => {
                const seeAllIndex = matchedCommands.length + hits.length;
                return (
                  <button
                    type="button"
                    id={rowDomId(seeAllIndex)}
                    role="option"
                    aria-selected={seeAllIndex === activeRowIndex}
                    className={`command-palette-row command-palette-see-all${seeAllIndex === activeRowIndex ? " active" : ""}`}
                    onMouseEnter={() => setActiveIndex(seeAllIndex)}
                    onClick={() => runRow({ kind: "see-all", count: search.results.length })}
                  >
                    See all results ({search.results.length})
                  </button>
                );
              })()}
              {watermark ? <p className="command-palette-watermark">{watermark}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
