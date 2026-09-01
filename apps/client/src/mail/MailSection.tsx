import { useCallback, useEffect, useMemo, useState } from "react";
import { THREAD_PAGE_SIZE, useMailAccounts, useThreadWindow } from "../store/index.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import {
  readLastAccountId,
  readStreamMode,
  readViewMode,
  writeLastAccountId,
  writeStreamMode,
  writeViewMode,
} from "./device-preferences.js";
import { ListView } from "./ListView.js";
import { SplitView } from "./SplitView.js";
import { StreamView } from "./StreamView.js";
import { TopBar } from "./TopBar.js";
import "./mail.css";

/**
 * The real thread list UI over the Local Cache (#40): the windowed,
 * time-grouped list, the Split (default) / List top-bar modes plus Stream
 * as an independent opt-in, and the account switcher. Everything renders
 * off `useThreadWindow` alone — no path here ever awaits a network
 * response (ADR-0010), which is what makes reopening a Thread <100ms.
 */
export function MailSection() {
  useLocalCacheSync();
  const mailAccounts = useMailAccounts();

  const [viewMode, setViewMode] = useState(readViewMode);
  const [streamMode, setStreamMode] = useState(readStreamMode);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [limit, setLimit] = useState(THREAD_PAGE_SIZE);

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
    writeLastAccountId(id);
  }, []);

  const changeViewMode = useCallback((mode: typeof viewMode) => {
    setViewMode(mode);
    writeViewMode(mode);
  }, []);

  const changeStreamMode = useCallback((enabled: boolean) => {
    setStreamMode(enabled);
    writeStreamMode(enabled);
  }, []);

  const page = useThreadWindow(accountId, { limit });
  const loadMore = useCallback(() => {
    setLimit((current) => current + THREAD_PAGE_SIZE);
  }, []);

  const threads = page?.threads ?? [];
  const ids = useMemo(() => threads.map((thread) => thread.id), [threads]);

  if (!mailAccounts || mailAccounts.length === 0) return null;
  if (!page) return null;

  return (
    <section className="mail-section">
      <TopBar
        viewMode={viewMode}
        onViewMode={changeViewMode}
        streamMode={streamMode}
        onStreamMode={changeStreamMode}
        accounts={mailAccounts}
        selectedAccountId={accountId}
        onSelectAccount={selectAccount}
      />
      <div className="mail-body">
        {streamMode ? (
          <StreamView
            threads={threads}
            ids={ids}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
          />
        ) : viewMode === "split" ? (
          <SplitView
            threads={threads}
            ids={ids}
            complete={page.complete}
            selectedThreadId={selectedThreadId}
            onSelect={setSelectedThreadId}
            onLoadMore={loadMore}
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
          />
        )}
      </div>
    </section>
  );
}
