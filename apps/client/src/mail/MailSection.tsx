import type { Label } from "@mail/shared";
import { labelNameFromId } from "@mail/shared";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { PendingSendBar } from "../compose/PendingSendBar.js";
import { SendFailureBanner } from "../compose/SendFailureBanner.js";
import { useComposeShortcut } from "../compose/useComposeShortcut.js";
import {
  newCompositionId,
  THREAD_PAGE_SIZE,
  useLabels,
  useMailAccounts,
  useThreadWindow,
} from "../store/index.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import {
  readLastAccountId,
  readOpenComposerId,
  readStreamMode,
  readViewMode,
  writeLastAccountId,
  writeStreamMode,
  writeViewMode,
} from "./device-preferences.js";
import { ListView } from "./ListView.js";
import { RollbackToast } from "./RollbackToast.js";
import { SplitView } from "./SplitView.js";
import { StreamView } from "./StreamView.js";
import { TopBar } from "./TopBar.js";
import { readAdvanceDirection, writeAdvanceDirection } from "./triage-preferences.js";
import { useTriage } from "./useTriage.js";
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
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [limit, setLimit] = useState(THREAD_PAGE_SIZE);
  const [direction, setDirection] = useState(readAdvanceDirection);
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

  const changeDirection = useCallback((next: typeof direction) => {
    setDirection(next);
    writeAdvanceDirection(next);
  }, []);

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

  // Called unconditionally, before the early returns below — Rules of
  // Hooks — and happily a no-op with `accountId: null` or an empty list,
  // the same "nothing cached yet" shape `useThreadWindow` already handles.
  const triage = useTriage({
    mailAccountId: accountId,
    threads,
    ids,
    selectedThreadId,
    onSelect: setSelectedThreadId,
    direction,
    shortcutsDisabled: composeId !== null,
  });

  if (!mailAccounts || mailAccounts.length === 0) return null;
  if (!page) return null;

  return (
    <section className="mail-section">
      <TopBar
        viewMode={viewMode}
        onViewMode={changeViewMode}
        streamMode={streamMode}
        onStreamMode={changeStreamMode}
        direction={direction}
        onDirection={changeDirection}
        accounts={mailAccounts}
        selectedAccountId={accountId}
        onSelectAccount={selectAccount}
        labels={labelsForPicker}
        labelFilter={labelFilter}
        onLabelFilter={selectLabelFilter}
        onCompose={openCompose}
      />
      <div className="mail-body">
        {streamMode ? (
          <StreamView
            threads={threads}
            ids={ids}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            triage={triage}
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
