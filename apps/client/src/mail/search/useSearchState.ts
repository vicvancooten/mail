import type {
  IndexWatermark,
  MailAccount,
  SearchResponse,
  SearchResult,
  Thread,
} from "@mail/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runServerSearch } from "../../api/search.js";
import {
  type CachedThread,
  materializeSearchResultThread,
  useSearchPrefilter,
  useSearchResultThreads,
} from "../../store/index.js";
import { addRecentSearch, clearRecentSearches, readRecentSearches } from "../device-preferences.js";
import type { Triage } from "../useTriage.js";
import {
  meetsSearchFloor,
  type ParsedSearchQuery,
  parseSearchQuery,
  setQueryOperator,
  stripStopwords,
  toggleTrashJunkOperator,
} from "./query-parser.js";
import { type SeededScope, seedScopeFromOrigin, type ViewOrigin } from "./scope.js";
import { useSearchOverlay } from "./useSearchOverlay.js";

/** How long after typing stops before `POST /search` fires (search-ux-spec.md §When a search runs). */
const SERVER_DEBOUNCE_MS = 200;

export interface DisplayResult {
  threadId: string;
  /** The server's own snapshot when this row came from `POST /search`; `null` for a prefilter-only row. */
  headline: string | null;
  folder: SearchResult["folder"] | null;
  matchedMessageId: string;
  /** The Held/Blocked badge (#56, `docs/search-ux-spec.md` §The row) — `SearchResult["gatekeeper"]`'s own doc comment explains why it rides the result, not the Thread. */
  gatekeeper: SearchResult["gatekeeper"];
}

function buildFilters(parsed: ParsedSearchQuery, folder?: string, label?: string) {
  return {
    text: stripStopwords(parsed.text),
    from: parsed.from,
    to: parsed.to,
    hasAttachment: parsed.hasAttachment,
    folder: parsed.folder ?? folder,
    label: parsed.label ?? label,
    after: parsed.after,
    before: parsed.before,
  };
}

export interface SearchState {
  active: boolean;
  queryText: string;
  parsed: ParsedSearchQuery;
  meetsFloor: boolean;
  seed: SeededScope;
  /** The seed still applies — nothing typed has overridden or popped it. */
  seedLive: boolean;
  effectiveFolder: string | undefined;
  effectiveLabel: string | undefined;
  results: readonly CachedThread[];
  displayById: ReadonlyMap<string, DisplayResult>;
  actedOnThreadIds: ReadonlySet<string>;
  usingServerResults: boolean;
  serverLoading: boolean;
  offline: boolean;
  needsReauth: boolean;
  indexWatermark: IndexWatermark | null;
  hasMore: boolean;
  loadingOlder: boolean;
  selectedThreadId: string | null;
  select: (id: string | null) => void;
  recentSearches: string[];

  open: (origin: ViewOrigin) => void;
  onFieldChange: (text: string) => void;
  onCommit: (text: string) => void;
  onEsc: () => void;
  onBackspaceEmpty: () => void;
  popSeed: () => void;
  setOperator: (key: string, value: string | null) => void;
  toggleTrashJunk: () => void;
  loadOlder: () => void;
  clearRecent: () => void;
  runRecent: (query: string) => void;
  markActedOn: (threadId: string) => void;
}

export function useSearchState(
  mailAccountId: string | null,
  mailAccounts: readonly MailAccount[],
): SearchState {
  const overlay = useSearchOverlay();
  const [seed, setSeed] = useState<SeededScope>(null);
  const [seedPopped, setSeedPopped] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [serverResponse, setServerResponse] = useState<SearchResponse | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [offline, setOffline] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => readRecentSearches());
  const [actedOn, setActedOn] = useState<ReadonlySet<string>>(new Set());
  const immediateRef = useRef(false);
  /** Set synchronously by `onEsc` right before it leaves — see that comment. */
  const justLeftRef = useRef(false);

  const parsed = useMemo(() => parseSearchQuery(overlay.query), [overlay.query]);
  const seedLive = !seedPopped && parsed.folder === undefined && parsed.label === undefined;
  const effectiveFolder =
    parsed.folder ?? (seedLive && seed?.kind === "folder" ? seed.folder : undefined);
  const effectiveLabel =
    parsed.label ?? (seedLive && seed?.kind === "label" ? seed.name : undefined);

  const mailAccount = mailAccounts.find((account) => account.id === mailAccountId) ?? null;
  const needsReauth = mailAccount?.status === "needs_reauth";
  const meetsFloor = meetsSearchFloor(parsed);

  const prefilterFilters = useMemo(
    () => ({
      text: parsed.text,
      from: parsed.from,
      to: parsed.to,
      hasAttachment: parsed.hasAttachment,
      folder: effectiveFolder,
      label: effectiveLabel,
      after: parsed.after,
      before: parsed.before,
    }),
    [parsed, effectiveFolder, effectiveLabel],
  );
  const prefilterThreads =
    useSearchPrefilter(overlay.active && meetsFloor ? mailAccountId : null, prefilterFilters) ?? [];

  // The server round trip (search-ux-spec.md §When a search runs): live,
  // debounced ~200ms after typing stops, from the 3-character floor. Enter
  // (`onCommit`) skips the wait — `immediateRef` is that seam.
  useEffect(() => {
    if (!overlay.active || !mailAccountId || !meetsFloor) {
      setServerResponse(null);
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setOffline(true);
      return;
    }
    let cancelled = false;
    const delay = immediateRef.current ? 0 : SERVER_DEBOUNCE_MS;
    immediateRef.current = false;
    const timer = setTimeout(() => {
      setServerLoading(true);
      runServerSearch({ mailAccountId, ...buildFilters(parsed, effectiveFolder, effectiveLabel) })
        .then((response) => {
          if (cancelled) return;
          setServerResponse(response);
          setOffline(false);
        })
        .catch(() => {
          if (!cancelled) setOffline(true);
        })
        .finally(() => {
          if (!cancelled) setServerLoading(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `parsed` is a `useMemo` keyed on `overlay.query` (above), so its
    // identity is already stable across unrelated renders — listing it
    // directly here is exactly as narrow as comparing its fields would be.
  }, [overlay.active, mailAccountId, meetsFloor, effectiveFolder, effectiveLabel, parsed]);

  const usingServerResults = serverResponse !== null;
  const previousDisplayResultsRef = useRef<readonly SearchResult[]>([]);
  const displayResults = useMemo(() => {
    const next = serverResponse
      ? serverResponse.results
      : prefilterThreads.map(
          (thread): SearchResult => ({
            thread,
            matchedMessageId: thread.lastMessageId ?? thread.id,
            headline: null,
            folder: { id: "", name: "", role: thread.inInbox ? "inbox" : null },
            // The offline prefilter is a substring scan over the Local Cache,
            // not a ranker (ADR-0016) — it can see this Thread's own Screening
            // Hold, but nothing about a *sender* verdict, so `blocked` is not a
            // badge it can honestly produce.
            gatekeeper: thread.heldSender ? ("held" as const) : null,
          }),
        );

    // ADR-0016: the prefilter is "rendered identically to server results...
    // and replaced wholesale when they arrive (skipping the re-render when
    // they agree)". A shallow ordered-id comparison against what's already
    // on screen — not a deep comparison of every field — is the cheap check
    // that catches the common case (the prefilter already found exactly
    // what the server did) without chasing every possible id order.
    const previous = previousDisplayResultsRef.current;
    const sameOrder =
      previous.length === next.length &&
      previous.every((result, index) => result.thread.id === next[index]?.thread.id);
    if (sameOrder) return previous;

    previousDisplayResultsRef.current = next;
    return next;
  }, [serverResponse, prefilterThreads]);

  const overlaidThreads = useSearchResultThreads(displayResults);
  const displayById = useMemo(() => {
    const map = new Map<string, DisplayResult>();
    for (const result of displayResults) {
      map.set(result.thread.id, {
        threadId: result.thread.id,
        headline: result.headline,
        folder: usingServerResults ? result.folder : null,
        matchedMessageId: result.matchedMessageId,
        gatekeeper: result.gatekeeper,
      });
    }
    return map;
  }, [displayResults, usingServerResults]);

  const open = useCallback(
    (origin: ViewOrigin) => {
      setSeed(seedScopeFromOrigin(origin));
      setSeedPopped(false);
      setSelectedThreadId(null);
      setRecentSearches(readRecentSearches());
      overlay.open();
    },
    [overlay],
  );

  const onFieldChange = useCallback(
    (text: string) => {
      overlay.updateQuery(text);
    },
    [overlay],
  );

  const onCommit = useCallback(
    (text: string) => {
      if (justLeftRef.current) {
        justLeftRef.current = false;
        return;
      }
      immediateRef.current = true;
      overlay.commitQuery(text);
      addRecentSearch(text);
      setRecentSearches(readRecentSearches());
    },
    [overlay],
  );

  const onEsc = useCallback(() => {
    if (overlay.query.length > 0) {
      onFieldChange("");
      return;
    }
    // The field blurs right behind this (`TopBar.tsx`'s own Escape
    // handler), which would otherwise re-commit the empty query and undo
    // the very `overlay.leave()` just made — `justLeftRef` is a ref rather
    // than state exactly so the very next synchronous call sees it, ahead
    // of any render.
    justLeftRef.current = true;
    overlay.leave();
  }, [overlay, onFieldChange]);

  const popSeed = useCallback(() => setSeedPopped(true), []);
  const onBackspaceEmpty = useCallback(() => popSeed(), [popSeed]);

  const setOperator = useCallback(
    (key: string, value: string | null) => {
      if (key === "in" || key === "label") popSeed();
      onFieldChange(setQueryOperator(overlay.query, key, value));
    },
    [overlay.query, onFieldChange, popSeed],
  );

  const toggleTrashJunk = useCallback(() => {
    popSeed();
    onFieldChange(toggleTrashJunkOperator(overlay.query));
  }, [overlay.query, onFieldChange, popSeed]);

  const loadOlder = useCallback(() => {
    if (!mailAccountId || !serverResponse?.cursor) return;
    setLoadingOlder(true);
    runServerSearch({
      mailAccountId,
      ...buildFilters(parsed, effectiveFolder, effectiveLabel),
      cursor: serverResponse.cursor,
    })
      .then((response) => {
        setServerResponse((current) =>
          current
            ? {
                results: [...current.results, ...response.results],
                cursor: response.cursor,
                indexWatermark: response.indexWatermark,
              }
            : response,
        );
        setOffline(false);
      })
      .catch(() => setOffline(true))
      .finally(() => setLoadingOlder(false));
  }, [mailAccountId, serverResponse?.cursor, parsed, effectiveFolder, effectiveLabel]);

  const clearRecent = useCallback(() => {
    clearRecentSearches();
    setRecentSearches([]);
  }, []);

  const runRecent = useCallback(
    (query: string) => {
      onCommit(query);
    },
    [onCommit],
  );

  const markActedOn = useCallback((threadId: string) => {
    setActedOn((current) => new Set(current).add(threadId));
  }, []);

  return {
    active: overlay.active,
    queryText: overlay.query,
    parsed,
    meetsFloor,
    seed,
    seedLive,
    effectiveFolder,
    effectiveLabel,
    results: overlaidThreads,
    displayById,
    actedOnThreadIds: actedOn,
    usingServerResults,
    serverLoading,
    offline,
    needsReauth,
    indexWatermark: serverResponse?.indexWatermark ?? mailAccount?.indexWatermark ?? null,
    hasMore: usingServerResults && serverResponse?.cursor !== null,
    loadingOlder,
    selectedThreadId,
    select: setSelectedThreadId,
    recentSearches,
    open,
    onFieldChange,
    onCommit,
    onEsc,
    onBackspaceEmpty,
    popSeed,
    setOperator,
    toggleTrashJunk,
    loadOlder,
    clearRecent,
    runRecent,
    markActedOn,
  };
}

/**
 * Materializes then acts (ADR-0016 §Acting on a result): wraps every
 * `Triage` method so the row it targets has a base row in the Local Cache
 * before the mutation is queued against it — "a result row can be pinned
 * into the Local Cache unchanged" (ADR-0016 §Wire shape) is the promise
 * this keeps. `archive`/`trash` additionally call `onActed`, which is what
 * lets a search result show "the row stays in place, visibly changed"
 * (search-ux-spec.md §Acting on a result) rather than being
 * indistinguishable from a still-in-Inbox match.
 */
export function wrapSearchTriage(
  triage: Triage,
  threads: readonly Thread[],
  onActed: (threadId: string) => void,
): Triage {
  const findThread = (threadId: string) => threads.find((thread) => thread.id === threadId);
  const materialize = (threadId: string) => {
    const thread = findThread(threadId);
    if (thread) void materializeSearchResultThread(thread);
  };
  return {
    archive: (threadId) => {
      materialize(threadId);
      onActed(threadId);
      triage.archive(threadId);
    },
    trash: (threadId) => {
      materialize(threadId);
      onActed(threadId);
      triage.trash(threadId);
    },
    toggleStar: (threadId) => {
      materialize(threadId);
      triage.toggleStar(threadId);
    },
    toggleRead: (threadId) => {
      materialize(threadId);
      triage.toggleRead(threadId);
    },
    togglePin: (threadId) => {
      materialize(threadId);
      triage.togglePin(threadId);
    },
    applyLabel: (threadId, name) => {
      materialize(threadId);
      triage.applyLabel(threadId, name);
    },
    removeLabel: (threadId, name) => {
      materialize(threadId);
      triage.removeLabel(threadId, name);
    },
  };
}
