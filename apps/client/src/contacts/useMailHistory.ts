import type { SearchResponse, SearchResult } from "@mail/shared";
import { normalizeCorrespondentAddress } from "@mail/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runServerSearch } from "../api/search.js";
import type { DisplayResult } from "../mail/search/useSearchState.js";
import { type CachedThread, useSearchResultThreads } from "../store/index.js";

/**
 * The Person Page's own Mail history tab (#217): "a search, not a stored
 * join" — every address on the Contact, OR'd across From/To/Cc via the
 * `participants` filter (`@mail/shared`'s own doc comment), across every
 * Mail Account in Account Scope, bounded by the Candidate Window like any
 * other search (ADR-0016). Deliberately its own small hook rather than
 * `useSearchState.ts` reused wholesale: that hook's debounce, query parser,
 * prefilter and recent-searches are all about a *typed* query, none of
 * which exists here — this is one request, re-run whenever the Contact's
 * addresses or Account Scope change, plus the same "load older" cursor
 * append `useSearchState.ts#loadOlder` already established.
 */
export interface MailHistoryState {
  results: readonly CachedThread[];
  displayById: ReadonlyMap<string, DisplayResult>;
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  loadOlder: () => void;
  /** No addresses on this Contact (and none of its Linked Contacts, once #222 lands) to search for at all — distinct from "searched, found nothing". */
  noAddresses: boolean;
  offline: boolean;
}

export function useMailHistory(
  participants: readonly string[],
  accountScope: readonly string[],
): MailHistoryState {
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [offline, setOffline] = useState(false);

  // Stable keys for the effect/callback deps below (`useSearchState.ts`'s
  // own bug-3 reasoning): both `participants` and `accountScope` are given
  // fresh array identities by their callers every render, but membership is
  // what should actually re-run the fetch — these two strings are what's
  // actually listed as deps, never the arrays themselves.
  const participantsKey = participants.join(" ");
  const accountScopeKey = accountScope.join(",");
  const mailAccountId = accountScope[0] ?? null;
  const rest = accountScope.slice(1);
  const additionalMailAccountIds = rest.length > 0 ? rest : undefined;
  const normalizedParticipants = participants.map((address) =>
    normalizeCorrespondentAddress(address),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `mailAccountId`/`accountScopeKey`/`participantsKey`, not `additionalMailAccountIds`/`normalizedParticipants` themselves — both are freshly computed above on every render, so listing them here would re-run this on every render rather than only when Scope or the Contact's addresses actually change.
  useEffect(() => {
    if (!mailAccountId || normalizedParticipants.length === 0) {
      setResponse(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    runServerSearch({
      mailAccountId,
      additionalMailAccountIds,
      text: "",
      participants: normalizedParticipants,
    })
      .then((next) => {
        if (cancelled) return;
        setResponse(next);
        setOffline(false);
      })
      .catch(() => {
        if (!cancelled) setOffline(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mailAccountId, accountScopeKey, participantsKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: same reasoning as the effect above.
  const loadOlder = useCallback(() => {
    if (!mailAccountId || !response?.cursor) return;
    setLoadingOlder(true);
    runServerSearch({
      mailAccountId,
      additionalMailAccountIds,
      text: "",
      participants: normalizedParticipants,
      cursor: response.cursor,
    })
      .then((next) => {
        setResponse((current) =>
          current
            ? {
                results: [...current.results, ...next.results],
                cursor: next.cursor,
                indexWatermark: next.indexWatermark,
              }
            : next,
        );
        setOffline(false);
      })
      .catch(() => setOffline(true))
      .finally(() => setLoadingOlder(false));
  }, [mailAccountId, accountScopeKey, participantsKey, response?.cursor]);

  const displayResults = response?.results ?? [];
  const results = useSearchResultThreads(displayResults);
  const displayById = useMemo(() => {
    const map = new Map<string, DisplayResult>();
    for (const result of displayResults as readonly SearchResult[]) {
      map.set(result.thread.id, {
        threadId: result.thread.id,
        headline: result.headline,
        folder: result.folder,
        matchedMessageId: result.matchedMessageId,
        gatekeeper: result.gatekeeper,
      });
    }
    return map;
  }, [displayResults]);

  return {
    results,
    displayById,
    loading,
    loadingOlder,
    hasMore: response?.cursor !== null && response?.cursor !== undefined,
    loadOlder,
    noAddresses: normalizedParticipants.length === 0,
    offline,
  };
}
