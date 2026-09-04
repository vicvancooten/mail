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

/**
 * The Index Watermark line (search-ux-spec.md §Degraded states, #79's
 * acceptance box: "shown when bodies are still being indexed") — shared
 * between `SearchResultsView`'s own foot and the Command Palette's inline
 * hits (`CommandPalette.tsx`), so the two surfaces read the same watermark
 * the same way rather than growing their own phrasing.
 */
export function formatIndexWatermark(watermark: IndexWatermark | null): string | null {
  if (!watermark || watermark.complete) return null;
  if (!watermark.coveredSince) {
    return "Still indexing this account — older mail matches on sender and subject only.";
  }
  const date = new Date(watermark.coveredSince).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });
  return `Bodies indexed back to ${date} — older mail matches on sender and subject only.`;
}

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

/**
 * The Account Scope beyond the primary account (#80, #68's
 * `additionalMailAccountIds`) — `undefined` rather than `[]` when Scope is
 * narrowed to one account, matching the wire contract's own "absent means
 * today's single-account default" so a single-account request looks exactly
 * like it did before Scope existed.
 */
function additionalScopeIds(accountScope: readonly string[]): string[] | undefined {
  const rest = accountScope.slice(1);
  return rest.length > 0 ? rest : undefined;
}

export interface SearchState {
  /** The results view is swapped into the list pane — `useSearchOverlay`'s own doc comment explains why this is a separate concern from the search merely running. */
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
  /** Engages the session (prefilter + server round trip run) without opening the results view — the Command Palette's own first keystroke, seeding the scope from `origin` exactly like `open` does (#100). */
  engage: (origin: ViewOrigin) => void;
  /** Opens the results view for an already-engaged session — the Palette's "See all results" (#100). */
  openResultsView: () => void;
  /** Leaves outright, restoring the origin — the results view's own visible Close (#100), unlike the field's two-stage `onEsc`. */
  close: () => void;
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

/**
 * `accountScope` (#80, `useAccountScope.ts`): every in-scope account is
 * searched, merged as the Sync Backend returns them (ADR-0016 amendment,
 * #68). `accountScope[0]` stays the primary — same "the *primary* in-scope
 * account" role it already plays everywhere else in `MailSection` — with
 * every other entry riding along as `additionalMailAccountIds` on the wire.
 * Widening or narrowing Scope while a search is active re-runs it: the
 * search effect below keys on the whole Scope, not just the primary.
 */
export function useSearchState(
  accountScope: readonly string[],
  mailAccounts: readonly MailAccount[],
): SearchState {
  const overlay = useSearchOverlay();
  const mailAccountId = accountScope[0] ?? null;
  const [seed, setSeed] = useState<SeededScope>(null);
  const [seedPopped, setSeedPopped] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  // Tagged with the request key it answers (#100, bug 6): a response is
  // only trusted — including an honestly empty one — once the query it was
  // requested for matches the one on screen right now, so a slow response
  // that lands after the User has already changed the query can't wholesale
  // erase local hits for a query it never actually answered.
  const [serverResponseState, setServerResponseState] = useState<{
    response: SearchResponse;
    forKey: string;
  } | null>(null);
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
    useSearchPrefilter(overlay.engaged && meetsFloor ? mailAccountId : null, prefilterFilters) ??
    [];

  // Stable identity for the round trip's own dep array (#100, bug 3):
  // `accountScope` is a fresh array every render/live-query emission by
  // design (`useAccountScope`'s own doc comment) — that's the *desired*
  // re-run trigger when Scope actually widens or narrows, but keying the
  // effect on the array itself re-runs it, cancelling an in-flight request,
  // on every render that merely re-creates an equal-content array. Keying
  // on the joined ids instead re-runs the effect only when membership
  // actually changes; the effect's own closure still reads the current
  // `accountScope` value, which is what the request itself needs.
  const accountScopeKey = accountScope.join(",");

  // What request "now" means — everything a `POST /search` response is an
  // answer *for*. Tagging the response with this (below) is bug 6's fix:
  // an empty response can only replace local hits once it's an answer to
  // the query still on screen, not a slow answer to one the User has since
  // changed past.
  const requestKey = useMemo(
    () =>
      JSON.stringify([
        mailAccountId,
        accountScopeKey,
        buildFilters(parsed, effectiveFolder, effectiveLabel),
      ]),
    [mailAccountId, accountScopeKey, parsed, effectiveFolder, effectiveLabel],
  );

  // The server round trip (search-ux-spec.md §When a search runs): live,
  // debounced ~200ms after typing stops, from the 3-character floor. Enter
  // (`onCommit`) skips the wait — `immediateRef` is that seam. Engaged
  // (`overlay.engaged`) rather than the results view being open
  // (`overlay.active`) is what gates this — the Palette's own inline hits
  // (#100) need this running well before "See all results" ever opens the
  // results view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `accountScope` itself (read in the body, for the request) is deliberately *not* a dep — bug 3's fix is keying this on `accountScopeKey` instead, since `accountScope` is a fresh array identity every render (`useAccountScope`'s own doc comment) and would re-run this on every one of them; `requestKey` already folds in everything `accountScopeKey`/`effectiveFolder`/`effectiveLabel`/`parsed` mean for the request, kept alongside them for readability rather than in place of them.
  useEffect(() => {
    if (!overlay.engaged || !mailAccountId || !meetsFloor) {
      // Always clear loading on settle (#100, bug 3): this branch settles
      // the search (there is nothing left to wait for), so a `serverLoading`
      // left over from a request an earlier effect instance started — and
      // whose own `.finally` a stale-response guard skipped — can't stick.
      setServerLoading(false);
      return;
    }
    let cancelled = false;
    const requestedKey = requestKey;
    const run = () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setOffline(true);
        setServerLoading(false);
        return;
      }
      setServerLoading(true);
      runServerSearch({
        mailAccountId,
        additionalMailAccountIds: additionalScopeIds(accountScope),
        ...buildFilters(parsed, effectiveFolder, effectiveLabel),
      })
        .then((response) => {
          if (cancelled) return;
          setServerResponseState({ response, forKey: requestedKey });
          setOffline(false);
        })
        .catch(() => {
          if (!cancelled) setOffline(true);
        })
        .finally(() => {
          // Unconditional (#100, bug 3): a superseded request must not leave
          // loading stuck true just because its own response is discarded.
          setServerLoading(false);
        });
    };
    const delay = immediateRef.current ? 0 : SERVER_DEBOUNCE_MS;
    immediateRef.current = false;
    const timer = setTimeout(run, delay);
    // Bug 8: `offline` otherwise only ever clears from a *later* request's
    // own success — stuck indefinitely if nothing else prompts a re-run
    // once connectivity actually returns. Retrying immediately on the
    // browser's own `online` event (registered unconditionally, so a query
    // that started life offline still gets one) is the same "no background
    // retry loop" contract (search-ux-spec.md §Degraded states) since it
    // fires once, from the network telling us something changed, not a poll.
    const handleOnline = () => run();
    window.addEventListener("online", handleOnline);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("online", handleOnline);
    };
    // `parsed` is a `useMemo` keyed on `overlay.query` (above), so its
    // identity is already stable across unrelated renders — listing it
    // directly here is exactly as narrow as comparing its fields would be.
  }, [
    overlay.engaged,
    mailAccountId,
    meetsFloor,
    effectiveFolder,
    effectiveLabel,
    parsed,
    accountScopeKey,
    requestKey,
  ]);

  // Only trusted once it answers the query on screen right now (bug 6,
  // above) — a response tagged for an older `requestKey` is treated as not
  // having arrived yet, same as before the request was ever sent.
  const serverResponse =
    serverResponseState?.forKey === requestKey ? serverResponseState.response : null;

  const usingServerResults = serverResponse !== null;
  const previousDisplayResultsRef = useRef<readonly SearchResult[]>([]);
  const previousSourceRef = useRef<"server" | "prefilter" | null>(null);
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
    const nextSource = serverResponse ? "server" : "prefilter";

    // ADR-0016: the prefilter is "rendered identically to server results...
    // and replaced wholesale when they arrive (skipping the re-render when
    // they agree)". A shallow ordered-id comparison against what's already
    // on screen — not a deep comparison of every field — is the cheap check
    // that catches the common case (the prefilter already found exactly
    // what the server did) without chasing every possible id order.
    //
    // Bug 7: that shortcut used to fire across a prefilter→server
    // transition too, whenever the ids happened to land in the same order —
    // silently keeping the prefilter's thinner rows (no headline, no folder
    // pill) on screen instead of the richer server ones that had actually
    // arrived. Gating it on the source staying the same closes that.
    const previous = previousDisplayResultsRef.current;
    const sameOrder =
      previousSourceRef.current === nextSource &&
      previous.length === next.length &&
      previous.every((result, index) => result.thread.id === next[index]?.thread.id);
    if (sameOrder) return previous;

    previousDisplayResultsRef.current = next;
    previousSourceRef.current = nextSource;
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

  // The Palette's own first keystroke (#100): engages the round
  // trip/prefilter — same scope-seeding as `open` — without opening the
  // results view, so top hits compute while the list pane behind the
  // Palette stays exactly what it already was.
  const engage = useCallback(
    (origin: ViewOrigin) => {
      setSeed(seedScopeFromOrigin(origin));
      setSeedPopped(false);
      setSelectedThreadId(null);
      overlay.engage();
    },
    [overlay],
  );

  // "See all results" (#100): opens the results view for the session the
  // Palette already engaged, without `open()`'s fresh-entry reset — the
  // seed and any arrow-selected hit carry straight over.
  const openResultsView = useCallback(() => overlay.openResultsView(), [overlay]);

  // The results view's own visible Close (#100): leaves outright and
  // restores the origin, in one click, unlike the field's two-stage `onEsc`.
  const close = useCallback(() => overlay.leave(), [overlay]);

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
    // The field blurs right behind this (`search/SearchField.tsx`'s own Escape
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
    const forKey = requestKey;
    runServerSearch({
      mailAccountId,
      additionalMailAccountIds: additionalScopeIds(accountScope),
      ...buildFilters(parsed, effectiveFolder, effectiveLabel),
      cursor: serverResponse.cursor,
    })
      .then((response) => {
        setServerResponseState((current) =>
          current
            ? {
                response: {
                  results: [...current.response.results, ...response.results],
                  cursor: response.cursor,
                  indexWatermark: response.indexWatermark,
                },
                forKey,
              }
            : { response, forKey },
        );
        setOffline(false);
      })
      .catch(() => setOffline(true))
      .finally(() => setLoadingOlder(false));
  }, [
    mailAccountId,
    accountScope,
    serverResponse?.cursor,
    parsed,
    effectiveFolder,
    effectiveLabel,
    requestKey,
  ]);

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
    engage,
    openResultsView,
    close,
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
 * this keeps. `archive`/`trash`/`snooze` additionally call `onActed`, which
 * is what lets a search result show "the row stays in place, visibly
 * changed" (search-ux-spec.md §Acting on a result) rather than being
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
      return triage.archive(threadId);
    },
    trash: (threadId) => {
      materialize(threadId);
      onActed(threadId);
      return triage.trash(threadId);
    },
    snooze: (threadId, until) => {
      materialize(threadId);
      onActed(threadId);
      return triage.snooze(threadId, until);
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
