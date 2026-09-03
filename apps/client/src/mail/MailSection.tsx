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
import { subscribeNotificationTarget } from "../pwa/notification-router.js";
import {
  enqueueUserMutation,
  newCompositionId,
  saveComposition,
  THREAD_PAGE_SIZE,
  useDraftCompositions,
  useLabels,
  useMailAccounts,
  usePreference,
  useScreenerSenders,
  useThreadWindow,
} from "../store/index.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import { DraftsView } from "./DraftsView.js";
import {
  type AccountScope as AccountScopeIds,
  readListDensity,
  readOpenComposerId,
  readStreamMode,
  readViewMode,
  writeListDensity,
  writeScreenerViewed,
  writeStreamMode,
  writeViewMode,
} from "./device-preferences.js";
import { DEFAULT_FOLDER, type FolderKey, folderToView } from "./folders.js";
import { ListView } from "./ListView.js";
import { NewMailToast } from "./NewMailToast.js";
import { NotificationOfferBanner } from "./NotificationOfferBanner.js";
import { RollbackToast } from "./RollbackToast.js";
import { Sidebar } from "./Sidebar.js";
import { SplitView } from "./SplitView.js";
import { StreamView } from "./StreamView.js";
import { GatekeeperBanner } from "./screener/GatekeeperBanner.js";
import { Screener } from "./screener/Screener.js";
import { SearchResultsView } from "./search/SearchResultsView.js";
import type { ViewOrigin } from "./search/scope.js";
import { useSearchState, wrapSearchTriage } from "./search/useSearchState.js";
import { TopBar } from "./TopBar.js";
import { useAccountScope } from "./useAccountScope.js";
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
 * plus Stream as an independent opt-in, Account Scope (#73), and triage.
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
 *
 * Account Scope (#73, `useAccountScope.ts`) is what `useThreadWindow` reads
 * *which* Mail Accounts from — merged into one newest-first list across
 * every account in Scope. `accountId` below stays a single id: the *primary*
 * in-scope account (Scope's first member), which is what every surface this
 * ticket does not redesign still needs one of — a new Composition's default
 * From, the Screener's grouping, Search's account context. Narrowing Scope
 * to exactly one account is what makes that primary and "the selected
 * account" the same thing again, same as before Scope existed.
 *
 * `initialLabelFilter`/`initialThreadId`/`onLocationChange` (#71) are the
 * seam the routed `/mail` view (`router/MailRoute.tsx`) uses to keep the URL
 * a mirror of "which label, which Thread" without this component knowing
 * anything about TanStack Router — every other caller (every test in this
 * file included) renders `<MailSection />` bare and gets exactly today's
 * unrouted behavior, seeded to Inbox/no-selection and reporting to nobody.
 */
export function MailSection({
  initialLabelFilter = null,
  initialFolder,
  initialThreadId = null,
  onLocationChange,
}: {
  initialLabelFilter?: string | null;
  initialFolder?: FolderKey;
  initialThreadId?: string | null;
  onLocationChange?: (location: {
    labelFilter: string | null;
    folder: FolderKey;
    threadId: string | null;
  }) => void;
} = {}) {
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
  // Account Scope (#73): the Thread list's own accounts; `accountId` below
  // is derived from it, not tracked separately — see the doc comment above.
  const { scope: accountScope, setScope: setAccountScope } = useAccountScope(mailAccounts);
  const accountId = accountScope[0] ?? null;
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThreadId);
  const [limit, setLimit] = useState(THREAD_PAGE_SIZE);
  // The sidebar folder destination (#74, `mail/folders.ts#FolderKey`): the
  // Screener is one of these entries too, so `screenerOpen` below is derived
  // from it rather than a second, independently-toggled boolean — one state
  // that both the Sidebar's "which entry is active" highlight and the body
  // switch below read, never two that could disagree.
  const [folder, setFolder] = useState<FolderKey>(initialFolder ?? DEFAULT_FOLDER);
  // The Screener (#56, poc-spec.md §Gatekeeper v1): its own full-screen swap
  // of `.mail-body`, the same shape `search.active` already uses below.
  const screenerOpen = folder === "screener";
  const screenerSenders = useScreenerSenders(accountId) ?? [];
  const draftCompositions = useDraftCompositions(accountId) ?? [];
  // Auto-advance on/off + direction (#54, poc-spec.md §Preferences):
  // User-scoped and synced — `usePreference()` already carries `base ⊕
  // pending`, so a change made offline (or on another device) is reflected
  // here the instant its Optimistic Action lands, no extra plumbing needed.
  const preference = usePreference();
  const autoAdvanceEnabled = preference?.autoAdvanceEnabled ?? DEFAULT_AUTO_ADVANCE_ENABLED;
  const direction = preference?.autoAdvanceDirection ?? DEFAULT_AUTO_ADVANCE_DIRECTION;
  // Filter-by-label (#43): "a label filter behaves as a view, bounded
  // window like any other" — `null` means the ordinary Inbox view.
  const [labelFilter, setLabelFilter] = useState<string | null>(initialLabelFilter);
  const labels = useLabels(accountId) ?? [];

  // Report label/Thread selection to whoever asked (`onLocationChange`) —
  // routed callers use this to keep `/mail`'s URL a mirror of this state
  // (#71); an unrouted caller (every test in this file) leaves it unset and
  // nothing happens.
  useEffect(() => {
    onLocationChange?.({ labelFilter, folder, threadId: selectedThreadId });
  }, [labelFilter, folder, selectedThreadId, onLocationChange]);

  // One composer at a time (#45, compose-spec §Composer surface & keys).
  // Reads `readOpenComposerId()` once, at mount, so a composer left open
  // across a reload reopens itself rather than the offline-durable draft
  // sitting unreachable in the Local Cache.
  const [composeId, setComposeId] = useState<string | null>(readOpenComposerId);
  // "One composer at a time" (compose-spec §Composer surface & keys) is
  // enforced right here, not just at the keyboard shortcut: every path that
  // wants to point `composeId` at a (possibly different) Composition — the
  // Compose button's mouse click included — goes through this no-op-while-
  // open guard, so swapping `composeId` can never unmount a live `Composer`
  // out from under unsaved typing (a `key={composeId}` change unmounts it
  // with no synchronous flush of whatever's still sitting in the debounce).
  // `useComposeShortcut`'s own `disabled` guard below is now redundant with
  // this, but harmless — it just means `c` never re-mints an id it would
  // throw away.
  const openComposer = useCallback((id: string) => {
    setComposeId((current) => current ?? id);
  }, []);
  const openCompose = useCallback(() => openComposer(newCompositionId()), [openComposer]);
  const closeCompose = useCallback(() => setComposeId(null), []);
  // Reopening an *existing* Composition: a cancelled send (ADR-0007 reopens
  // the composer on whichever device cancelled) and the "Open draft" button
  // on a failed send both land here — and both share the same guard above,
  // since swapping away from an *open* composer to reopen a different one is
  // exactly the same drops-unsaved-typing hazard the Compose button has.
  const reopenCompose = useCallback(
    (compositionId: string) => openComposer(compositionId),
    [openComposer],
  );
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

  // Account Scope resolution — which accounts exist, and the default-to-all
  // fallback — lives in `useAccountScope` itself now (#73); this component
  // only ever reads `accountScope`/`accountId` back.

  // Narrows Scope to exactly one account: the one path (a notification
  // click landing on an account not currently primary) where a *single*
  // account still has to be picked out from the rest, the same "switch to
  // it" behavior the pre-Scope account switcher had. Resets the transient
  // view state the same way a User-driven Scope change to a new primary
  // does (`changeAccountScope` below) — including the folder (#74), since a
  // narrowed Scope may not have the previous folder's contents at all.
  const narrowScopeTo = useCallback(
    (id: string) => {
      setAccountScope([id]);
      setSelectedThreadId(null);
      setLimit(THREAD_PAGE_SIZE);
      setLabelFilter(null);
      setFolder(DEFAULT_FOLDER);
      setScreenerOpen(false);
    },
    [setAccountScope],
  );

  // The Account Scope control's own onChange (#73): the transient view
  // state (selection, label filter, folder, Screener, page size) only
  // resets when the *primary* account (Scope's first member) actually
  // changes — adding or removing a non-primary account from Scope shouldn't
  // drop whatever the User was looking at.
  const changeAccountScope = useCallback(
    (ids: AccountScopeIds) => {
      const previousPrimary = accountId;
      setAccountScope(ids);
      if (ids[0] !== previousPrimary) {
        setSelectedThreadId(null);
        setLimit(THREAD_PAGE_SIZE);
        setLabelFilter(null);
        setFolder(DEFAULT_FOLDER);
        setScreenerOpen(false);
      }
    },
    [accountId, setAccountScope],
  );

  // Opening the Screener *is* "viewing" it (`device-preferences.ts`'s own
  // doc comment) — the banner's unseen cursor advances the instant this
  // fires, not on some later "you scrolled past every row" heuristic.
  const openScreener = useCallback(() => {
    if (!accountId) return;
    writeScreenerViewed(accountId);
    setFolder("screener");
  }, [accountId]);
  const closeScreener = useCallback(() => setFolder(DEFAULT_FOLDER), []);

  // The Sidebar's folder destinations (#74): every entry but Screener lands
  // here directly; Screener's own `writeScreenerViewed` side effect means it
  // still goes through `openScreener` above rather than a bare `setFolder`.
  const selectFolder = useCallback(
    (next: FolderKey) => {
      if (next === "screener") {
        openScreener();
        return;
      }
      setFolder(next);
      setLabelFilter(null);
      setSelectedThreadId(null);
      setLimit(THREAD_PAGE_SIZE);
    },
    [openScreener],
  );

  // A notification click landing here (#53, ADR-0015: "a click always
  // lands where the next decision is"): the service worker only knows how
  // to focus/open this one window, so `notification-router.ts` is what
  // turns "which Thread / Composition" into React state once the click
  // actually reaches this component. `needs-reauth` isn't handled here —
  // that target names a Mail Account's *Settings*, a different route now
  // (#71), and lands in `router/RootLayout.tsx` instead, which is mounted
  // regardless of which route is current.
  useEffect(() => {
    return subscribeNotificationTarget((target) => {
      switch (target.kind) {
        case "thread":
          if (target.mailAccountId !== accountId) narrowScopeTo(target.mailAccountId);
          setLabelFilter(null);
          setFolder(DEFAULT_FOLDER);
          setSelectedThreadId(target.threadId);
          return;
        case "failed-send":
          // Same "Open draft" path `SendFailureBanner`'s own click uses —
          // the restored Draft in the composer, per ADR-0015.
          if (target.mailAccountId !== accountId) narrowScopeTo(target.mailAccountId);
          reopenCompose(target.compositionId);
          return;
        case "needs-reauth":
          return;
      }
    });
  }, [accountId, narrowScopeTo, reopenCompose]);

  const selectLabelFilter = useCallback((labelId: string | null) => {
    setLabelFilter(labelId);
    setSelectedThreadId(null);
    setLimit(THREAD_PAGE_SIZE);
    if (labelId !== null) setFolder(DEFAULT_FOLDER);
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
    () => (labelFilter ? ({ kind: "label", labelId: labelFilter } as const) : folderToView(folder)),
    [labelFilter, folder],
  );
  // Account Scope (#73): merges every in-scope account's Threads into one
  // newest-first list (`useThreadWindow`'s own doc comment) — the acceptance
  // criteria's "Thread list shows only in-scope Threads".
  const page = useThreadWindow(accountScope, { view, limit });
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
    shortcutsDisabled: composeId !== null || search.active || screenerOpen,
  });
  const rawSearchTriage = useTriage({
    mailAccountId: accountId,
    threads: search.results,
    ids: useMemo(() => search.results.map((thread) => thread.id), [search.results]),
    selectedThreadId: search.selectedThreadId,
    onSelect: search.select,
    direction,
    autoAdvanceEnabled,
    shortcutsDisabled: composeId !== null || !search.active || screenerOpen,
  });
  const searchTriage = wrapSearchTriage(rawSearchTriage, search.results, search.markActedOn);

  // `/` and `⌘K`/`Ctrl-K` open search and focus the field from anywhere in
  // the mail section (search-ux-spec.md §The surface), except while typing
  // elsewhere or with the composer open — the same "not typing" guard
  // `useTriage`'s own scheme uses.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (composeId !== null || screenerOpen) return;
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
  }, [composeId, screenerOpen]);

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
        accountScope={accountScope}
        onAccountScopeChange={changeAccountScope}
        labels={labelsForPicker}
        labelFilter={labelFilter}
        onLabelFilter={selectLabelFilter}
        onCompose={openCompose}
        screener={{ count: screenerSenders.length, onOpen: openScreener }}
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
      {/* Unmounted rather than merely hidden while the Screener is open: a
          `readScreenerSeenUntil` read only happens on mount/account change
          (`GatekeeperBanner`'s own doc comment), and `openScreener` just
          wrote a fresh cursor — remounting is what picks it up, so the
          banner doesn't still claim "unseen" for holds it was just shown. */}
      {!screenerOpen && <GatekeeperBanner mailAccountId={accountId} onOpen={openScreener} />}
      <div className="mail-frame">
        <Sidebar
          folder={folder}
          onSelectFolder={selectFolder}
          labels={labelsForPicker}
          labelFilter={labelFilter}
          onSelectLabel={selectLabelFilter}
          onCompose={openCompose}
          screenerCount={screenerSenders.length}
          draftsCount={draftCompositions.length}
        />
        <div className="mail-body">
          {screenerOpen && accountId ? (
            <Screener mailAccountId={accountId} onClose={closeScreener} />
          ) : search.active ? (
            <SearchResultsView
              viewMode={viewMode}
              state={search}
              triage={searchTriage}
              onReply={openReply}
              accounts={mailAccounts}
              mailAccountId={accountId}
            />
          ) : folder === "drafts" ? (
            <DraftsView drafts={draftCompositions} onOpen={reopenCompose} />
          ) : folder === "snoozed" ? (
            <div className="mail-empty-state" role="status">
              Nothing snoozed yet — Snooze lands in its own ticket.
            </div>
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
      </div>
      <SendFailureBanner mailAccountId={accountId} onOpen={reopenCompose} />
      <PendingSendBar mailAccountId={accountId} onReopen={reopenCompose} />
      <RollbackToast />
      <NewMailToast />
      <NotificationOfferBanner />
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
