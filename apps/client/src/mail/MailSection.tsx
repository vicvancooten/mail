import type { AutoAdvanceDirection, Label, Message } from "@mail/shared";
import {
  DEFAULT_AUTO_ADVANCE_DIRECTION,
  DEFAULT_AUTO_ADVANCE_ENABLED,
  labelNameFromId,
} from "@mail/shared";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PendingSendBar } from "../compose/PendingSendBar.js";
import { buildReplyContent, type ReplyMode } from "../compose/reply.js";
import { SendFailureBanner } from "../compose/SendFailureBanner.js";
import { useComposeShortcut } from "../compose/useComposeShortcut.js";
import {
  enqueueUserMutation,
  newCompositionId,
  saveComposition,
  THREAD_PAGE_SIZE,
  useLabels,
  useMailAccounts,
  usePreference,
  useThreadWindow,
} from "../store/index.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import {
  readLastAccountId,
  readListDensity,
  readOpenComposerId,
  readStreamMode,
  readViewMode,
  writeLastAccountId,
  writeListDensity,
  writeStreamMode,
  writeViewMode,
} from "./device-preferences.js";
import { ListView } from "./ListView.js";
import { RollbackToast } from "./RollbackToast.js";
import { SplitView } from "./SplitView.js";
import { StreamView } from "./StreamView.js";
import { SearchResultsView } from "./search/SearchResultsView.js";
import type { ViewOrigin } from "./search/scope.js";
import { useSearchState, wrapSearchTriage } from "./search/useSearchState.js";
import { TopBar } from "./TopBar.js";
import { useTriage } from "./useTriage.js";
import { COMPACT_ROW_HEIGHT } from "./VirtualizedThreadList.js";
import "./mail.css";

/**
 * Lazy-loaded (compose-spec §Editor: "TipTap v3 ... lazy-loaded so it never
 * touches the <1s cold-start budget"): TipTap and its extensions are real
 * weight, and nothing before the first `c`/Compose click needs any of it.
 */
const Composer = lazy(() =>
  import("../compose/Composer.js").then((m) => ({ default: m.Composer })),
);

/**
 * The real thread list UI over the Local Cache (#40, #42, #43): the
 * windowed, time-grouped list, the Split (default) / List top-bar modes
 * plus Stream as an independent opt-in, the account switcher, and triage.
 * `useTriage` is called exactly once, here, so archive, trash, star, read,
 * pin, and label mean the same thing no matter which view is showing; every
 * view below is handed the same actions and never enqueues a mutation on
 * its own. Everything renders off `useThreadWindow` alone — no path here
 * ever awaits a network response (ADR-0010), which is what makes reopening
 * a Thread <100ms and a triage action <50ms.
 *
 * `labelFilter` (#43) picks which `ViewKey` `useThreadWindow` reads: `null`
 * is the ordinary Inbox, a Label id filters it — see `store/db.ts#ViewKey`
 * for why that's a client-side filter over the one synced window rather
 * than a second one.
 */
export function MailSection() {
  useLocalCacheSync();
  const mailAccounts = useMailAccounts();

  const [viewMode, setViewMode] = useState(readViewMode);
  const [streamMode, setStreamMode] = useState(readStreamMode);
  // List density (#54, CONTEXT.md's Device Preference): local `useState`
  // seeded from `localStorage`, same mechanics as `viewMode`/`streamMode`
  // above — deliberately never synced, because density means something
  // different on each device the User signs in from.
  const [density, setDensity] = useState(readListDensity);
  const rowHeight = density === "compact" ? COMPACT_ROW_HEIGHT : undefined;
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [limit, setLimit] = useState(THREAD_PAGE_SIZE);
  // Auto-advance on/off + direction (#54, poc-spec.md §Preferences):
  // User-scoped and synced — `usePreference()` already carries `base ⊕
  // pending`, so a change made offline (or on another device) is reflected
  // here the instant its Optimistic Action lands, no extra plumbing needed.
  const preference = usePreference();
  const autoAdvanceEnabled = preference?.autoAdvanceEnabled ?? DEFAULT_AUTO_ADVANCE_ENABLED;
  const direction = preference?.autoAdvanceDirection ?? DEFAULT_AUTO_ADVANCE_DIRECTION;
  // Filter-by-label (#43): "a label filter behaves as a view, bounded
  // window like any other" — `null` means the ordinary Inbox view.
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const labels = useLabels(accountId) ?? [];

  // One composer at a time (#45, compose-spec §Composer surface & keys).
  // Reads `readOpenComposerId()` once, at mount, so a composer left open
  // across a reload reopens itself rather than the offline-durable draft
  // sitting unreachable in the Local Cache.
  const [composeId, setComposeId] = useState<string | null>(readOpenComposerId);
  const openCompose = useCallback(() => setComposeId(newCompositionId()), []);
  const closeCompose = useCallback(() => setComposeId(null), []);
  // Reopening an *existing* Composition: a cancelled send (ADR-0007 reopens
  // the composer on whichever device cancelled) and the "Open draft" button
  // on a failed send both land here.
  const reopenCompose = useCallback((compositionId: string) => setComposeId(compositionId), []);
  useComposeShortcut(openCompose, composeId !== null);

  // Reply/reply-all/forward (#47): seeds a freshly-minted Composition
  // (`compose/reply.ts#buildReplyContent`) *before* the composer ever
  // mounts, `force`d the same way an attach-before-any-keystroke is
  // (`store/compositions.ts#saveComposition`'s own doc comment) — so by the
  // time `<Composer>` reads `useComposition(id)` on its first hydration
  // effect, the row is already there to hydrate from. "One composer at a
  // time" (compose-spec) is why this no-ops while one is already open,
  // matching `useComposeShortcut`'s own suppression.
  const openReply = useCallback(
    (message: Message, mode: ReplyMode) => {
      if (composeId !== null || !mailAccounts) return;
      const account = mailAccounts.find((candidate) => candidate.id === message.mailAccountId);
      if (!account) return;
      const id = newCompositionId();
      void saveComposition(id, account.id, buildReplyContent(mode, message, account), {
        force: true,
      }).then(() => setComposeId(id));
    },
    [composeId, mailAccounts],
  );

  // Pick the active account once accounts are known: the remembered device
  // preference if it still names one of them, else the first by
  // `createdAt` (stable across reloads, per the account switcher's own
  // ordering).
  useEffect(() => {
    if (!mailAccounts || mailAccounts.length === 0 || accountId !== null) return;
    const remembered = readLastAccountId();
    const stillExists = remembered && mailAccounts.some((account) => account.id === remembered);
    setAccountId(stillExists ? remembered : (mailAccounts[0]?.id ?? null));
  }, [mailAccounts, accountId]);

  const selectAccount = useCallback((id: string) => {
    setAccountId(id);
    setSelectedThreadId(null);
    setLimit(THREAD_PAGE_SIZE);
    setLabelFilter(null);
    writeLastAccountId(id);
  }, []);

  const selectLabelFilter = useCallback((labelId: string | null) => {
    setLabelFilter(labelId);
    setSelectedThreadId(null);
    setLimit(THREAD_PAGE_SIZE);
  }, []);

  const changeViewMode = useCallback((mode: typeof viewMode) => {
    setViewMode(mode);
    writeViewMode(mode);
  }, []);

  const changeStreamMode = useCallback((enabled: boolean) => {
    setStreamMode(enabled);
    writeStreamMode(enabled);
  }, []);

  const changeDensity = useCallback((next: typeof density) => {
    setDensity(next);
    writeListDensity(next);
  }, []);

  const changeDirection = useCallback(
    (next: AutoAdvanceDirection) => {
      void enqueueUserMutation({
        type: "setAutoAdvance",
        enabled: autoAdvanceEnabled,
        direction: next,
      });
    },
    [autoAdvanceEnabled],
  );

  const view = useMemo(
    () => (labelFilter ? ({ kind: "label", labelId: labelFilter } as const) : "all"),
    [labelFilter],
  );
  const page = useThreadWindow(accountId, { view, limit });
  const loadMore = useCallback(() => {
    setLimit((current) => current + THREAD_PAGE_SIZE);
  }, []);

  const threads = page?.threads ?? [];
  const ids = useMemo(() => threads.map((thread) => thread.id), [threads]);

  // The filter-by-label picker's data source (#43): the synced `Label`
  // collection, plus any id the currently loaded page's Threads carry that
  // hasn't synced back yet — a Label applied offline is filterable the
  // instant it's applied, not once a round trip confirms it. See
  // `labelNameFromId`'s doc comment for why decoding the name needs no
  // lookup.
  const labelsForPicker = useMemo(() => {
    if (!accountId) return [];
    const byId = new Map(labels.map((label): [string, Label] => [label.id, label]));
    for (const thread of threads) {
      for (const id of thread.labelIds) {
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            mailAccountId: accountId,
            name: labelNameFromId(accountId, id),
            updatedAt: "",
          });
        }
      }
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [labels, threads, accountId]);

  // Search (#51, `docs/search-ux-spec.md`): one hook owns the route, the
  // parse, the prefilter + server round trip and the merged result set;
  // MailSection's only job is feeding it this account and wiring its own
  // `useTriage` instance — the same "one shared hook so actions mean the
  // same thing" reasoning as the triage instance above, kept separate only
  // because a result's selection/neighbor set is a different list.
  const search = useSearchState(accountId, mailAccounts ?? []);
  const searchOrigin = useMemo<ViewOrigin>(
    () =>
      labelFilter
        ? {
            kind: "label",
            name: labelsForPicker.find((label) => label.id === labelFilter)?.name ?? "",
          }
        : { kind: "inbox" },
    [labelFilter, labelsForPicker],
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Called unconditionally, before the early returns below — Rules of
  // Hooks — and happily a no-op with `accountId: null` or an empty list,
  // the same "nothing cached yet" shape `useThreadWindow` already handles.
  // Stream is suppressed and the segmented control muted while searching
  // (search-ux-spec.md §The surface) — `search.active` joins `composeId` in
  // disabling this hook's own keydown listener so a result row's `j`/`k`
  // (handled by `searchTriage` below) is the only scheme live at once.
  const triage = useTriage({
    mailAccountId: accountId,
    threads,
    ids,
    selectedThreadId,
    onSelect: setSelectedThreadId,
    direction,
    autoAdvanceEnabled,
    shortcutsDisabled: composeId !== null || search.active,
  });
  const rawSearchTriage = useTriage({
    mailAccountId: accountId,
    threads: search.results,
    ids: useMemo(() => search.results.map((thread) => thread.id), [search.results]),
    selectedThreadId: search.selectedThreadId,
    onSelect: search.select,
    direction,
    autoAdvanceEnabled,
    shortcutsDisabled: composeId !== null || !search.active,
  });
  const searchTriage = wrapSearchTriage(rawSearchTriage, search.results, search.markActedOn);

  // `/` and `⌘K`/`Ctrl-K` open search and focus the field from anywhere in
  // the mail section (search-ux-spec.md §The surface), except while typing
  // elsewhere or with the composer open — the same "not typing" guard
  // `useTriage`'s own scheme uses.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (composeId !== null) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const isShortcut =
        event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key === "k");
      if (!isShortcut || (typing && event.key === "/")) return;
      event.preventDefault();
      // Focusing is enough — `TopBar`'s own `onFocus` is what opens search
      // when it isn't already active (`SearchField`'s own doc comment).
      // Opening here too would double-push the route (two `/search` history
      // entries for one open), which then takes two Back presses to leave.
      searchInputRef.current?.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composeId]);

  if (!mailAccounts || mailAccounts.length === 0) return null;
  if (!page) return null;

  return (
    <section className="mail-section">
      <TopBar
        viewMode={viewMode}
        onViewMode={changeViewMode}
        streamMode={streamMode}
        onStreamMode={changeStreamMode}
        density={density}
        onDensity={changeDensity}
        direction={direction}
        onDirection={changeDirection}
        accounts={mailAccounts}
        selectedAccountId={accountId}
        onSelectAccount={selectAccount}
        labels={labelsForPicker}
        labelFilter={labelFilter}
        onLabelFilter={selectLabelFilter}
        onCompose={openCompose}
        search={{
          active: search.active,
          queryText: search.queryText,
          inputRef: searchInputRef,
          onChange: search.onFieldChange,
          onCommit: search.onCommit,
          onEsc: search.onEsc,
          onBackspaceEmpty: search.onBackspaceEmpty,
          onOpen: () => search.open(searchOrigin),
          recentSearches: search.recentSearches,
          onRunRecent: search.runRecent,
          onClearRecent: search.clearRecent,
        }}
      />
      <div className="mail-body">
        {search.active ? (
          <SearchResultsView
            viewMode={viewMode}
            state={search}
            triage={searchTriage}
            onReply={openReply}
            accounts={mailAccounts}
            mailAccountId={accountId}
          />
        ) : streamMode ? (
          <StreamView
            threads={threads}
            ids={ids}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            triage={triage}
            onReply={openReply}
          />
        ) : viewMode === "split" ? (
          <SplitView
            threads={threads}
            ids={ids}
            complete={page.complete}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            onClearSelection={() => setSelectedThreadId(null)}
            onLoadMore={loadMore}
            triage={triage}
            onReply={openReply}
            initialScrollThreadId={selectedThreadId}
            rowHeight={rowHeight}
          />
        ) : (
          <ListView
            threads={threads}
            ids={ids}
            complete={page.complete}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            onBack={() => setSelectedThreadId(null)}
            onLoadMore={loadMore}
            triage={triage}
            onReply={openReply}
            initialScrollThreadId={selectedThreadId}
            rowHeight={rowHeight}
          />
        )}
      </div>
      <SendFailureBanner mailAccountId={accountId} onOpen={reopenCompose} />
      <PendingSendBar mailAccountId={accountId} onReopen={reopenCompose} />
      <RollbackToast />
      {composeId && accountId && (
        <Suspense fallback={null}>
          <Composer
            key={composeId}
            compositionId={composeId}
            mailAccounts={mailAccounts}
            defaultMailAccountId={accountId}
            onClose={closeCompose}
          />
        </Suspense>
      )}
    </section>
  );
}
