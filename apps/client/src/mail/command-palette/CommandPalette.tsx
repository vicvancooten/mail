import type { MailAccount } from "@mail/shared";
import { Command as CommandPrimitive } from "cmdk";
import { Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CachedThread } from "../../store/index.js";
import type { ActionContext } from "../actions/types.js";
import { readCommandUsage, recordCommandUsage } from "../device-preferences.js";
import type { ViewOrigin } from "../search/scope.js";
import { formatIndexWatermark, type SearchState } from "../search/useSearchState.js";
import { buildCommands, type PaletteCommand } from "./commands.js";
import { type LocalHit, useLocalHits } from "./local-hits.js";

/** `onOpenLocalHit`'s own no-op default — see that prop's doc comment below. */
function noop() {}

/** At most this many most-used commands in the empty state (#148) — same size as the "~5 recent searches" it sits beside. */
const MOST_USED_LIMIT = 5;

/** A palette row is a Command, a mail hit, a local hit (#196, ADR-0023), or a recent search (#148) — one flat, keyboard-navigable list (#79's "keyboard-complete"). */
type PaletteRow =
  | { kind: "command"; command: PaletteCommand }
  | { kind: "hit"; thread: CachedThread }
  | { kind: "local"; hit: LocalHit }
  | { kind: "see-all"; count: number }
  | { kind: "recent"; query: string };

function rowValue(row: PaletteRow): string {
  if (row.kind === "command") return `command:${row.command.id}`;
  if (row.kind === "hit") return `hit:${row.thread.id}`;
  if (row.kind === "local") return `local:${row.hit.key}`;
  if (row.kind === "recent") return `recent:${row.query}`;
  return "see-all";
}

/** How many local hits the Palette shows inline — `search.results.slice(0, 5)` below's own cap, matched rather than invented fresh. */
const LOCAL_HITS_LIMIT = 5;

/** One `LocalHit` group per section, in first-seen order — generic over however many Apps have joined the mechanism (#196: "so Contacts and Tasks can declare into it"), not hardcoded to Notes' one section. */
function groupLocalHitsBySection(hits: readonly LocalHit[]): [string, LocalHit[]][] {
  const bySection = new Map<string, LocalHit[]>();
  for (const hit of hits) {
    const group = bySection.get(hit.section);
    if (group) group.push(hit);
    else bySection.set(hit.section, [hit]);
  }
  return [...bySection.entries()];
}

function matchesQuery(command: PaletteCommand, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    command.label.toLowerCase().includes(needle) ||
    (command.shortcut?.toLowerCase().includes(needle) ?? false)
  );
}

/** `>` narrows the list to commands only (docs/search-ux-spec.md §Search & commands, #148) — everything after it (and any space right after the `>`) is the command filter text; the raw field text, `>` included, stays what the input displays and what Mail's own search keeps running underneath (harmlessly unused while hidden), since the query string is still the single source of truth. */
const COMMAND_FILTER_PREFIX = /^>\s*/;

function commandOnlyQuery(query: string): { active: boolean; text: string } {
  if (!query.startsWith(">")) return { active: false, text: query };
  return { active: true, text: query.replace(COMMAND_FILTER_PREFIX, "") };
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
 * bar field does, plus `search.engage()` on the first keystroke — which
 * runs the same prefilter/server round trip `search.active` always has,
 * *without* opening the results view (#100: the Palette must never swap the
 * list pane just because someone is typing). Enter on a hit
 * (`search.select`) opens it in the reading pane the same way, still
 * without opening the results view. **"See all results"** is the only row
 * that calls `search.openResultsView()` — that's what swaps the list pane
 * into `MailSection`'s own `<SearchResultsView>` for real.
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
  ctx,
  search,
  searchOrigin,
  accounts,
  accountScope,
  onOpenLocalHit = noop,
}: {
  open: boolean;
  onClose: () => void;
  /** The Action registry's context for right now (#94) — one object in place of the nine callbacks this component used to take, and the same one the keyboard and every menu read. */
  ctx: ActionContext;
  search: SearchState;
  searchOrigin: ViewOrigin;
  accounts: readonly MailAccount[];
  /** Which Mail Account a hit came from is only worth naming once a search actually spans more than one (#80, same "several are in Scope" gate `SearchResultsView`'s own row badge uses). */
  accountScope: readonly string[];
  /**
   * Selecting a local hit (#196) navigates outside Mail entirely
   * (`/notes/:noteId` today) — a plain `to`/`params` pair rather than a
   * typed route, since this component has no business knowing every App's
   * routes. `router/RootLayout.tsx` is the one caller that actually holds a
   * `navigate` (moved there with the Palette itself, #147/#133 — a local
   * hit's destination is never Mail-scoped state, so it needs no relay
   * through whichever Mail-family surface happens to be mounted, unlike
   * `ctx`/`searchOrigin` above).
   *
   * Optional, no-op default only so a bare `<CommandPalette>` in a test
   * keeps compiling without inventing a handler it never exercises.
   */
  onOpenLocalHit?: (to: string, params: Record<string, string>) => void;
}) {
  // `search.engage` (#100) seeds the scope from `searchOrigin` the same way
  // `open` does, so it must fire once per Palette session rather than on
  // every keystroke — otherwise a mid-session `popSeed` (backspace on an
  // empty field) would be undone by the very next character typed.
  const engagedRef = useRef(false);

  // Autofocus (cmdk's `Input` `autoFocus`) handles focus on each fresh
  // mount, but this component never unmounts while closed (`if (!open)
  // return null` below, after every hook) — `engagedRef` needs its own
  // reset on reopen, or a second Palette session would skip `search.engage`
  // entirely, believing an earlier session already ran it.
  useEffect(() => {
    if (open) engagedRef.current = false;
  }, [open]);

  const query = search.queryText;
  // The truly empty field (#148, docs/search-ux-spec.md §The empty field) —
  // distinct from `>` alone, which is a live command filter with an empty
  // filter text and so still matches every command, just none of them
  // "most-used" or curated.
  const isEmptyField = query.length === 0;
  const { active: commandOnly, text: commandFilterText } = commandOnlyQuery(query);

  const commands = useMemo(() => buildCommands(ctx), [ctx]);

  const matchedCommands = useMemo(
    () => commands.filter((command) => matchesQuery(command, commandFilterText)),
    [commands, commandFilterText],
  );

  // Top hits (#79's "shows the top hits inline"): only once the floor is
  // met — below it `search.results` is whatever the *previous* query left
  // behind (`useSearchState`'s own overlay), which would otherwise flash
  // stale hits under an unrelated command search. `>` suppresses them
  // outright (docs/search-ux-spec.md: "`>` narrows the list to commands
  // only") — the mail round trip keeps running underneath on the raw field
  // text so it's ready the instant `>` is removed, it just never renders.
  const showHits = !commandOnly && !isEmptyField && search.meetsFloor;
  const hits = showHits ? search.results.slice(0, 5) : [];
  const showAccountBadge = accountScope.length > 1;

  // Local hits (#196, ADR-0023): a plain client-side match over an
  // already-whole-replicated collection (`local-hits.ts`'s own doc comment)
  // — no floor, no debounce, unlike Mail's server-backed `hits` above, since
  // there is no round trip here to protect from firing on every keystroke.
  // Ranked beneath commands and mail hits in the merged list (the ticket's
  // own words) simply by being the third Group rendered, below — gated on a
  // non-empty query the same way `showHits` is, so the empty-field state
  // (recent searches / most-used commands, #148) never has a Local section
  // to disagree with.
  const allLocalHits = useLocalHits(query);
  const localHits = query.trim().length > 0 ? allLocalHits.slice(0, LOCAL_HITS_LIMIT) : [];
  const localHitsBySection = groupLocalHitsBySection(localHits);

  // Ranking (#148, docs/search-ux-spec.md §Search & commands): matching
  // commands first, capped at three *only* once Mail hits are also on
  // screen — `>` and "nothing matched as mail" both leave the cap off, so
  // commands never lose rows to a cap nothing beneath them needs.
  const rankedCommands = hits.length > 0 ? matchedCommands.slice(0, 3) : matchedCommands;

  // The empty state's own most-used commands (#148): refreshed each time
  // the Palette opens — recording a run only ever closes it — rather than
  // on every keystroke, the same "refresh on `open()`" shape
  // `useSearchState`'s own `recentSearches` already uses.
  const [usage, setUsage] = useState<Readonly<Record<string, number>>>(() => readCommandUsage());
  useEffect(() => {
    if (open) setUsage(readCommandUsage());
  }, [open]);

  const mostUsedCommands = useMemo(() => {
    if (!isEmptyField) return [];
    const withUsage = commands.map((command, index) => ({
      command,
      index,
      count: usage[command.id] ?? 0,
    }));
    const everRun = withUsage.filter((entry) => entry.count > 0);
    // A device with no run history yet still gets a usable list — the
    // registry's own declaration order, the same one every command list
    // already falls back to.
    const ranked = everRun.length > 0 ? everRun : withUsage;
    return ranked
      .sort((a, b) => b.count - a.count || a.index - b.index)
      .slice(0, MOST_USED_LIMIT)
      .map((entry) => entry.command);
  }, [isEmptyField, commands, usage]);

  const recentSearches = isEmptyField ? search.recentSearches : [];

  // Whether the list is genuinely empty, computed from what the two render
  // branches below actually show — never from cmdk's own `filtered.count`.
  // That count comes from `Command.Item`s registering themselves via
  // `useLayoutEffect` on mount, which for the Mail hits group churns on
  // nearly every keystroke (`hits` is sourced from an async
  // prefilter/server round trip): a keystroke that empties and instantly
  // repopulates the Mail group can leave cmdk's own bookkeeping believing
  // the list is momentarily empty even while `rankedCommands` still has
  // real, on-screen rows — which is what rendered "No matches" under real
  // results for a frame. Since this component already knows the true
  // count, `Command.Empty` (whose visibility cmdk drives from that
  // separate, async-desynced source) is skipped entirely in favor of this.
  // The empty-field branch never has Local hits (gated above), so only the
  // non-empty-field branch needs `localHits` in the check.
  const isEmpty = isEmptyField
    ? mostUsedCommands.length === 0 && recentSearches.length === 0
    : rankedCommands.length === 0 && hits.length === 0 && localHits.length === 0;

  function runRow(row: PaletteRow) {
    if (row.kind === "command") {
      if (!row.command.run) return;
      recordCommandUsage(row.command.id);
      row.command.run();
      onClose();
      return;
    }
    if (row.kind === "hit") {
      // Opens the top (or arrow-selected) hit in Split — the reading pane
      // only. The list pane stays exactly what it already was; "See all
      // results", below, is the only row that swaps it (#100).
      search.select(row.thread.id);
      onClose();
      return;
    }
    if (row.kind === "local") {
      // Unlike a mail hit, a local hit's own App owns the whole screen it
      // navigates to — there is no reading-pane-only middle ground here
      // (the ticket's own "navigates to /notes/:noteId and opens the
      // Note's dialog over the grid").
      onOpenLocalHit(row.hit.to, row.hit.params);
      onClose();
      return;
    }
    if (row.kind === "recent") {
      // "Clickable to re-run" (search-ux-spec.md §The empty field): runs
      // that historical query and opens the full results view for it, same
      // "See all results" move below rather than a half-open inline state.
      search.runRecent(row.query);
      search.openResultsView();
      onClose();
      return;
    }
    search.onCommit(query);
    search.openResultsView();
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

  function commandRow(command: PaletteCommand) {
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
  }

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
              // Engages the round trip (prefilter + debounced server search)
              // without opening the results view — the list pane behind the
              // Palette stays untouched while typing (#100).
              if (!engagedRef.current) {
                engagedRef.current = true;
                search.engage(searchOrigin);
              }
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
          {isEmpty ? <p className="command-palette-empty">No matches.</p> : null}

          {isEmptyField ? (
            <>
              {recentSearches.length > 0 ? (
                <CommandPrimitive.Group
                  className="command-palette-section"
                  heading={
                    <span className="command-palette-section-heading">
                      Recent searches
                      <button
                        type="button"
                        className="command-palette-clear-recent"
                        onClick={() => search.clearRecent()}
                      >
                        Clear
                      </button>
                    </span>
                  }
                >
                  {recentSearches.map((recentQuery) => {
                    const row: PaletteRow = { kind: "recent", query: recentQuery };
                    return (
                      <CommandPrimitive.Item
                        key={recentQuery}
                        value={rowValue(row)}
                        onSelect={() => runRow(row)}
                        className="command-palette-row"
                      >
                        <Search size={13} className="command-palette-recent-icon" />
                        <span className="command-palette-row-label">{recentQuery}</span>
                      </CommandPrimitive.Item>
                    );
                  })}
                </CommandPrimitive.Group>
              ) : null}

              {mostUsedCommands.length > 0 ? (
                <CommandPrimitive.Group className="command-palette-section" heading="Commands">
                  {mostUsedCommands.map(commandRow)}
                </CommandPrimitive.Group>
              ) : null}
            </>
          ) : (
            <>
              {rankedCommands.length > 0 ? (
                <CommandPrimitive.Group className="command-palette-section" heading="Commands">
                  {rankedCommands.map(commandRow)}
                </CommandPrimitive.Group>
              ) : null}

              {hits.length > 0 ? (
                <CommandPrimitive.Group className="command-palette-section" heading="Mail">
                  {hits.map((thread) => {
                    const row: PaletteRow = { kind: "hit", thread };
                    const display = search.displayById.get(thread.id);
                    const participants =
                      thread.participants.map((p) => p.name ?? p.address).join(", ") ||
                      "(no sender)";
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

              {/* Local hits (#196): ranked beneath Commands and Mail, per section — one Group per App that has joined the mechanism, "Notes" today. Gated on a non-empty query (`localHits` above), so this never renders in the empty-field branch. */}
              {localHitsBySection.map(([section, sectionHits]) => (
                <CommandPrimitive.Group
                  key={section}
                  className="command-palette-section"
                  heading={section}
                >
                  {sectionHits.map((hit) => {
                    const row: PaletteRow = { kind: "local", hit };
                    return (
                      <CommandPrimitive.Item
                        key={hit.key}
                        value={rowValue(row)}
                        onSelect={() => runRow(row)}
                        className="command-palette-row"
                      >
                        <span className="command-palette-hit-subject">{hit.title}</span>
                      </CommandPrimitive.Item>
                    );
                  })}
                </CommandPrimitive.Group>
              ))}
            </>
          )}
        </CommandPrimitive.List>
      </CommandPrimitive>
    </div>
  );
}
