import type { MailAccount } from "@mail/shared";
import { Command as CommandPrimitive } from "cmdk";
import { Search, X } from "lucide-react";
import { type KeyboardEvent, useMemo } from "react";
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

function rowValue(row: PaletteRow): string {
  if (row.kind === "command") return `command:${row.command.id}`;
  if (row.kind === "hit") return `hit:${row.thread.id}`;
  return "see-all";
}

function matchesQuery(command: PaletteCommand, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    command.label.toLowerCase().includes(needle) ||
    (command.shortcut?.toLowerCase().includes(needle) ?? false)
  );
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
 * The list/input/keyboard-nav shell is cmdk (#93) — `shouldFilter={false}`
 * since `matchedCommands`/`hits` are already the pre-filtered set
 * (`search`'s own floor/debounce for hits, `matchesQuery` for commands),
 * so cmdk only ever owns Up/Down/Enter and the roving `aria-selected`
 * highlight (`mail.css`'s own `.command-palette-row[aria-selected="true"]`)
 * across whichever rows are actually mounted — never a second filtering
 * pass on top of ours. The backdrop, its own outside-click/Escape
 * dismissal and focus-return, stay hand-rolled exactly as before: this is
 * a full-viewport modal already built to the comp, not one of the
 * hand-rolled popovers/menus #93 replaces.
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
  // Rules of Hooks: called unconditionally even with nothing selected —
  // `useThreadMessages("")`'s own doc comment is what makes that a no-op.
  const { messages } = useThreadMessages(selectedThread?.id ?? "");
  const latestMessage = messages?.at(-1) ?? null;

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
    // Up/Down/Enter are cmdk's own (the root's `onKeyDown`, which this
    // bubbles to) — only Escape's two-stage "clear text, then leave" is
    // this component's own, so it's the one key stopped here before cmdk
    // or the surrounding Dialog-less backdrop ever see it.
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (query.length > 0) {
      search.onFieldChange("");
    } else {
      search.onEsc();
      onClose();
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
      <CommandPrimitive
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        label="Search commands and mail"
        shouldFilter={false}
      >
        <div className="command-palette-input-row">
          <Search size={15} className="command-palette-icon" />
          <CommandPrimitive.Input
            autoFocus
            placeholder="Search commands or mail…"
            value={query}
            onValueChange={(value) => {
              if (!search.active) search.open(searchOrigin);
              search.onFieldChange(value);
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

        <CommandPrimitive.List className="command-palette-list">
          <CommandPrimitive.Empty className="command-palette-empty">
            No matching commands.
          </CommandPrimitive.Empty>

          {matchedCommands.length > 0 ? (
            <CommandPrimitive.Group className="command-palette-section" heading="Commands">
              {matchedCommands.map((command) => {
                const row: PaletteRow = { kind: "command", command };
                const disabled = !command.run || Boolean(command.disabledReason);
                return (
                  <CommandPrimitive.Item
                    key={command.id}
                    value={rowValue(row)}
                    disabled={disabled}
                    onSelect={() => runRow(row)}
                    className={`command-palette-row${disabled ? " disabled" : ""}`}
                    title={command.disabledReason}
                  >
                    <span className="command-palette-row-section">{command.section}</span>
                    <span className="command-palette-row-label">{command.label}</span>
                    {command.shortcut ? (
                      <kbd className="keycap">{command.shortcut}</kbd>
                    ) : (
                      <span className="command-palette-unbound">unbound</span>
                    )}
                  </CommandPrimitive.Item>
                );
              })}
            </CommandPrimitive.Group>
          ) : null}

          {hits.length > 0 ? (
            <CommandPrimitive.Group className="command-palette-section" heading="Mail">
              {hits.map((thread) => {
                const row: PaletteRow = { kind: "hit", thread };
                const display = search.displayById.get(thread.id);
                const participants =
                  thread.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)";
                const accountLabel = showAccountBadge
                  ? accounts.find((candidate) => candidate.id === thread.mailAccountId)
                      ?.emailAddress
                  : null;
                return (
                  <CommandPrimitive.Item
                    key={thread.id}
                    value={rowValue(row)}
                    onSelect={() => runRow(row)}
                    className="command-palette-row"
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
                  </CommandPrimitive.Item>
                );
              })}
              <CommandPrimitive.Item
                value="see-all"
                onSelect={() => runRow({ kind: "see-all", count: search.results.length })}
                className="command-palette-row command-palette-see-all"
              >
                See all results ({search.results.length})
              </CommandPrimitive.Item>
              {watermark ? <p className="command-palette-watermark">{watermark}</p> : null}
            </CommandPrimitive.Group>
          ) : null}
        </CommandPrimitive.List>
      </CommandPrimitive>
    </div>
  );
}
