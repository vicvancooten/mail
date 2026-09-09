import type { Message } from "@mail/shared";
import { useEffect, useState } from "react";
import { fetchThreadMessages } from "../../api/messages.js";

/**
 * A per-tab cache: reopening a Thread already fetched this session skips the
 * round trip. Deliberately *not* the Local Cache (ADR-0009's disposable
 * IndexedDB store) — Message has no delta protocol at PoC scope
 * (`packages/shared/src/messages.ts`'s own docstring), so this is a plain
 * in-memory convenience, gone on reload, not a synced collection.
 */
const cache = new Map<string, Message[]>();

/**
 * Drops a set of Threads' cached Messages (#145): a Gatekeeper decision
 * changes the sender's Verdict, and with it every one of their Threads'
 * `remoteImagesAllowed` — the backend re-resolves that on every fetch
 * (`sync-backend/src/routes/messages.ts`), so the client's only job is to
 * stop serving the stale cached copy. Called with the deciding sender's own
 * held `threadIds`, never the whole cache, so other senders' open Threads
 * keep their cached Messages.
 */
export function invalidateThreadMessages(threadIds: readonly string[]): void {
  for (const threadId of threadIds) cache.delete(threadId);
}

export interface ThreadMessagesState {
  messages: Message[] | null;
  loading: boolean;
  error: boolean;
}

/**
 * Fetches (and caches) every Message in a Thread — `ThreadDetailPane`'s
 * reading-pane content. `threadId === ""` (the Command Palette's own
 * `useThreadMessages(selectedThread?.id ?? "")`, #79 — Rules of Hooks means
 * it must call this unconditionally even with nothing selected) is a
 * deliberate no-op: no cache entry, no fetch, `messages` stays `null`.
 */
export function useThreadMessages(threadId: string): ThreadMessagesState {
  const [state, setState] = useState<ThreadMessagesState>(() => {
    const cached = threadId ? cache.get(threadId) : undefined;
    return cached
      ? { messages: cached, loading: false, error: false }
      : { messages: null, loading: threadId !== "", error: false };
  });

  useEffect(() => {
    if (!threadId) {
      setState({ messages: null, loading: false, error: false });
      return;
    }
    const cached = cache.get(threadId);
    if (cached) {
      setState({ messages: cached, loading: false, error: false });
      return;
    }

    let cancelled = false;
    setState({ messages: null, loading: true, error: false });
    fetchThreadMessages(threadId)
      .then((messages) => {
        if (cancelled) return;
        cache.set(threadId, messages);
        setState({ messages, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ messages: null, loading: false, error: true });
      });

    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return state;
}
