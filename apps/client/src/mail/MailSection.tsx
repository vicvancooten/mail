import type {
  BulkTriageAccountOutcome,
  BulkTriageAction,
  Label,
  MailAccount,
  Message,
} from "@mail/shared";
import {
  BULK_TRIAGE_UNDO_WINDOW_SECONDS,
  DEFAULT_AUTO_ADVANCE_DIRECTION,
  DEFAULT_AUTO_ADVANCE_ENABLED,
  labelNameFromId,
} from "@mail/shared";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  countBulkTriageTarget,
  runBulkTriageBatch,
  undoBulkTriageBatch,
} from "../api/bulk-triage.js";
import { PendingSendBar } from "../compose/PendingSendBar.js";
import { buildReplyContent, type ReplyMode } from "../compose/reply.js";
import { SendFailureBanner } from "../compose/SendFailureBanner.js";
import { useComposeShortcut } from "../compose/useComposeShortcut.js";
import { subscribeNotificationTarget } from "../pwa/notification-router.js";
import {
  EMPTY_COMPOSE_CONTENT,
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
import { generateUlid } from "../store/ulid.js";
import { requestSyncNow } from "../sync/sync-loop.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import { CommandPalette } from "./command-palette/CommandPalette.js";
import {
  consumeGlobalPaletteOpenRequest,
  subscribeGlobalPaletteOpen,
} from "./command-palette/global-open.js";
import { ShortcutSheet } from "./command-palette/ShortcutSheet.js";
import { DraftsView } from "./DraftsView.js";
import {
  readOpenComposerId,
  readStreamMode,
  useListDensity,
  useViewMode,
  writeScreenerViewed,
  writeStreamMode,
} from "./device-preferences.js";
import { DEFAULT_FOLDER, type FolderKey, folderToView } from "./folders.js";
import { showGroupBulkToast } from "./GroupBulkToast.js";
import { bulkTriageFolderRoleForFolder, bulkTriageTarget, groupDateRange } from "./group-target.js";
import { ListView } from "./ListView.js";
import { NewMailToast } from "./NewMailToast.js";
import { NotificationOfferBanner } from "./NotificationOfferBanner.js";
import { RollbackToast } from "./RollbackToast.js";
import type { MailtoLink } from "./reading/mailto.js";
import { Sidebar } from "./Sidebar.js";
import { SplitView } from "./SplitView.js";
import { StreamView } from "./StreamView.js";
import { GatekeeperBanner } from "./screener/GatekeeperBanner.js";
import { Screener } from "./screener/Screener.js";
import { SearchField } from "./search/SearchField.js";
import { SearchResultsView } from "./search/SearchResultsView.js";
import type { ViewOrigin } from "./search/scope.js";
import { useSearchState, wrapSearchTriage } from "./search/useSearchState.js";
import { timeGroupLabel } from "./time-groups.js";
import { useAccountScope } from "./useAccountScope.js";
import { useTriage } from "./useTriage.js";
import { GROUP_STAGGER_ROW_CAP, type GroupBulkController } from "./VirtualizedThreadList.js";
import "./mail.css";

/** The group header cluster's own stagger-then-collapse timing (#66, #77) —
 * matches `mail.css`'s `.thread-list [data-clearing]` animation duration, so
 * a Thread is only hidden from `threads` once its own leave animation has
 * actually finished playing. */
const GROUP_STAGGER_STEP_MS = 45;
const GROUP_COLLAPSE_DURATION_MS = 260;
/** How long a plain (non-undoable) group-bulk toast — a partial failure, a rollback — stays up. Shorter than the Undo toast's `BULK_TRIAGE_UNDO_WINDOW_SECONDS`, since there's nothing left to act on. */
const GROUP_BULK_MESSAGE_TOAST_MS = 6_000;

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
 * in-scope account (Scope's first member), which several surfaces still need
 * one of — Search's account context, and (#81) a new Composition's
 * User-level default From, the last resort in the chain `openCompose` below
 * resolves: the single in-scope account, else (for a reply/forward,
 * `openReply`) the Message's own arriving account, else this primary — with
 * Scope narrowed to exactly one account, that primary and "the selected
 * account" are the same thing again, same as before Scope existed. The
 * Screener (#82) is one of the surfaces that *does* read the whole
 * `accountScope` now, grouping held senders by account rather than
 * collapsing to the primary alone.
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

  // View mode and list density (#99): reactive Device Preferences now
  // (`device-preferences.ts#useViewMode`/`useListDensity`), so a change made
  // from Settings' "This device" page (`settings/ThisDeviceSection.tsx`)
  // reaches this component instantly — the ticket's own acceptance
  // criterion ("changing density in Settings updates the list immediately").
  // Stream mode stays a plain seeded `useState`: its own toggle lives here
  // in the toolbar still, and its Device Preference is retired by a
  // separate ticket (#105), not this one.
  const [viewMode] = useViewMode();
  const [streamMode, setStreamMode] = useState(readStreamMode);
  const [density] = useListDensity();
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
  // Account Scope (#82): the Screener groups held senders by Mail Account
  // across the whole Scope, not just the primary account.
  const screenerAccountGroups = useScreenerSenders(accountScope) ?? [];
  const screenerSenderCount = screenerAccountGroups.reduce(
    (sum, group) => sum + group.senders.length,
    0,
  );
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
  // nothing happens. `reportedThreadIdRef` stamps every value *this*
  // component hands out, so the effect below can tell that apart from one
  // that arrived some other way (see its own doc comment).
  const reportedThreadIdRef = useRef(initialThreadId);
  useEffect(() => {
    reportedThreadIdRef.current = selectedThreadId;
    onLocationChange?.({ labelFilter, folder, threadId: selectedThreadId });
  }, [labelFilter, folder, selectedThreadId, onLocationChange]);

  // The phone back gesture (#81, mail#66: "a working back gesture supplied
  // by the router, the way every other app on the phone behaves"):
  // `initialThreadId` no longer only seeds `selectedThreadId` once at mount
  // — `router/MailRoute.tsx` pushes a history entry the first time a Thread
  // opens from no selection, and a later change to this prop that this
  // component did *not* itself just report through `onLocationChange` above
  // (`reportedThreadIdRef` is what tells the two apart) means the Back
  // gesture popped that entry: the URL's own `thread` search param moved on
  // its own, and the reading pane has to close (or swap Threads) to match,
  // not just leave the pane open over a URL that no longer names it.
  useEffect(() => {
    if (initialThreadId === reportedThreadIdRef.current) return;
    reportedThreadIdRef.current = initialThreadId;
    setSelectedThreadId(initialThreadId);
  }, [initialThreadId]);

  // One composer at a time (#45, compose-spec §Composer surface & keys).
  // Reads `readOpenComposerId()` once, at mount, so a composer left open
  // across a reload reopens itself rather than the offline-durable draft
  // sitting unreachable in the Local Cache.
  const [composeId, setComposeId] = useState<string | null>(readOpenComposerId);
  // The From resolution chain (#81, mail#66 "From respects Account Scope"):
  // `null` while the sending account is already settled (a reply/forward, a
  // reopened Composition, or Scope narrowed to one account) — `Composer`
  // renders a locked label for those. A list of 2+ accounts means a brand
  // new compose left it ambiguous, so `Composer` renders an explicit picker
  // instead (see its own doc comment). Set alongside `composeId` by the same
  // three callbacks below, never independently — there is always exactly
  // one composer open, so there is only ever one answer to "can its From be
  // chosen".
  const [composeFromChoices, setComposeFromChoices] = useState<MailAccount[] | null>(null);
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
  // Brand-new compose (#81): the only one of the three open paths that can
  // ever hand `Composer` a real `fromChoices` list — a reply's and a
  // reopened Composition's account is already settled (see the state's own
  // doc comment above). Guards on `composeId` itself, same reasoning as
  // `openComposer`'s guard: skipped while a composer is already open, so
  // this never clobbers *its* choices out from under it.
  const openCompose = useCallback(() => {
    if (composeId !== null) return;
    setComposeFromChoices(
      accountScope.length > 1
        ? (mailAccounts ?? []).filter((account) => accountScope.includes(account.id))
        : null,
    );
    openComposer(newCompositionId());
  }, [composeId, openComposer, accountScope, mailAccounts]);
  const closeCompose = useCallback(() => setComposeId(null), []);
  // Reopening an *existing* Composition: a cancelled send (ADR-0007 reopens
  // the composer on whichever device cancelled) and the "Open draft" button
  // on a failed send both land here — and both share the same guard above,
  // since swapping away from an *open* composer to reopen a different one is
  // exactly the same drops-unsaved-typing hazard the Compose button has. Its
  // account is already settled (the row's own `mailAccountId`, which
  // `Composer` hydrates into itself) — never a fresh choice.
  const reopenCompose = useCallback(
    (compositionId: string) => {
      setComposeFromChoices(null);
      openComposer(compositionId);
    },
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
  //
  // The From account (#81): always the arriving Message's own account
  // (`message.mailAccountId`), never Account Scope's primary one and never
  // a choice — asserted in `Composer.test.tsx` against the seeded row this
  // writes. That is what keeps a reply from silently leaving off whichever
  // account happens to be primary when Scope holds several.
  const openReply = useCallback(
    (message: Message, mode: ReplyMode) => {
      if (composeId !== null || !mailAccounts) return;
      const account = mailAccounts.find((candidate) => candidate.id === message.mailAccountId);
      if (!account) return;
      const id = newCompositionId();
      setComposeFromChoices(null);
      void saveComposition(id, account.id, buildReplyContent(mode, message, account), {
        force: true,
      }).then(() => setComposeId(id));
    },
    [composeId, mailAccounts],
  );

  // A `mailto:` link clicked inside a Message body (ADR-0018's click
  // bridge, `MessageBody.tsx`): the same "one composer at a time" guard as
  // `openReply`, but there is no arriving Message to settle the From
  // account against, so it follows `openCompose`'s own choice instead
  // (Account Scope's primary account, or a picker when Scope holds
  // several) — a `mailto:` link says nothing about which of the User's
  // Mail Accounts should send the reply.
  const openMailto = useCallback(
    (link: MailtoLink) => {
      if (composeId !== null || !mailAccounts || !accountId) return;
      setComposeFromChoices(
        accountScope.length > 1
          ? mailAccounts.filter((account) => accountScope.includes(account.id))
          : null,
      );
      const id = newCompositionId();
      void saveComposition(
        id,
        accountId,
        { ...EMPTY_COMPOSE_CONTENT, to: link.to, subject: link.subject ?? "" },
        { force: true },
      ).then(() => openComposer(id));
    },
    [composeId, mailAccounts, accountId, accountScope, openComposer],
  );

  // Account Scope resolution — which accounts exist, and the default-to-all
  // fallback — lives in `useAccountScope` itself now (#73); this component
  // only ever reads `accountScope`/`accountId` back.

  // Account Scope's own control lives in the Hub now (#96,
  // `router/RootLayout.tsx`), a different component instance from this one —
  // so "reset the transient view state when the *primary* account (Scope's
  // first member) actually changes" can no longer be a side effect wrapped
  // around the setter a caller here hands out (the old `changeAccountScope`).
  // Instead this watches `accountId` itself, the same "react to the shared
  // store's value, not to who wrote it" posture the count-invalidation
  // effect below already takes on `accountScope[0]`. Adding or removing a
  // non-primary account from Scope doesn't change `accountId` and so still
  // doesn't drop whatever the User was looking at. `narrowScopeTo` below
  // stamps this ref itself, synchronously, so this effect's own reset never
  // fires a render *after* one of that callback's own callers (the
  // notification handlers) already placed a specific Thread/Composition —
  // this effect would otherwise wipe that out a tick later.
  const previousPrimaryAccountRef = useRef(accountId);
  useEffect(() => {
    const previousPrimary = previousPrimaryAccountRef.current;
    previousPrimaryAccountRef.current = accountId;
    if (accountId === previousPrimary) return;
    // `null` means "Scope hadn't resolved to a real primary account yet"
    // (`useMailAccounts` resolves the Local Cache a render or two after
    // mount) — that first settling is not a User-driven Scope change, and
    // resetting `initialThreadId`'s own selection out from under a fresh
    // routed mount (`router/MailRoute.tsx`'s own `?thread=` restore) would
    // be exactly the drift this effect exists to prevent, not fix.
    if (previousPrimary === null) return;
    setSelectedThreadId(null);
    setLimit(THREAD_PAGE_SIZE);
    setLabelFilter(null);
    setFolder(DEFAULT_FOLDER);
  }, [accountId]);

  // Narrows Scope to exactly one account: the one path (a notification
  // click landing on an account not currently primary) where a *single*
  // account still has to be picked out from the rest, the same "switch to
  // it" behavior the pre-Scope account switcher had. Resets the transient
  // view state the same way the effect above does for a User-driven Scope
  // change — including the folder (#74), since a narrowed Scope may not
  // have the previous folder's contents at all — and stamps
  // `previousPrimaryAccountRef` itself so that effect doesn't redo (and
  // re-fire a render behind) the same reset once `accountId` actually
  // catches up.
  const narrowScopeTo = useCallback(
    (id: string) => {
      setAccountScope([id]);
      previousPrimaryAccountRef.current = id;
      setSelectedThreadId(null);
      setLimit(THREAD_PAGE_SIZE);
      setLabelFilter(null);
      setFolder(DEFAULT_FOLDER);
    },
    [setAccountScope],
  );

  // Opening the Screener *is* "viewing" it (`device-preferences.ts`'s own
  // doc comment) — the banner's unseen cursor advances the instant this
  // fires, not on some later "you scrolled past every row" heuristic.
  const openScreener = useCallback(() => {
    if (accountScope.length === 0) return;
    // Every account in Scope, not just the primary — the Screener now shows
    // (and the banner now counts) holds across all of them (#82).
    for (const id of accountScope) writeScreenerViewed(id);
    setFolder("screener");
  }, [accountScope]);
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

  const changeStreamMode = useCallback((enabled: boolean) => {
    setStreamMode(enabled);
    writeStreamMode(enabled);
  }, []);

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

  // Group bulk Triage (#66, #67, #77): Done all / Mark all read on a whole
  // date-group header, dispatched through the batch endpoint rather than
  // `useTriage`'s Optimistic Action queue (#67 — "outside the Optimistic
  // Action queue too: those name one Thread each, and a group can hold
  // thousands the Client never loaded"). Only wired for the folders the
  // batch endpoint's own wire vocabulary can name (`group-target.ts`), and
  // never while a Label filter has narrowed what's actually on screen out
  // from under `folder`.
  const bulkFolderRole = useMemo(
    () => (labelFilter === null ? bulkTriageFolderRoleForFolder(folder) : null),
    [folder, labelFilter],
  );
  // A group's true total (`POST /bulk-triage/count`), keyed by its own
  // label — fetched lazily, once per label, the first time its header is
  // armed (`requestGroupCount` below), not eagerly for every header on
  // every render.
  const [groupCounts, setGroupCounts] = useState<Record<string, number>>({});
  const requestedCountLabels = useRef<Set<string>>(new Set());
  // Threads mid-stagger (leaving, not yet gone) and Threads already hidden
  // once their own collapse finished — two states, not one, because the
  // stagger animation (`mail.css`) needs to actually play before a Thread
  // disappears from the list outright.
  const [clearingThreadIds, setClearingThreadIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [hiddenThreadIds, setHiddenThreadIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Switching what target set is even on screen — a different folder or a
  // narrowed Account Scope — invalidates every count already fetched and
  // abandons any mid-flight collapse; neither belongs to the new view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both deps are deliberately re-run triggers the body never reads — `accountScope` is a fresh array identity every render (`useAccountScope`) too, so comparing its primary id is what "the target set changed" means here, same posture `changeAccountScope` above already takes.
  useEffect(() => {
    setGroupCounts({});
    requestedCountLabels.current = new Set();
    setClearingThreadIds(new Set());
    setHiddenThreadIds(new Set());
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }, [bulkFolderRole, accountScope[0]]);

  useEffect(() => {
    return () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
  }, []);

  const requestGroupCount = useCallback(
    (label: string) => {
      if (!bulkFolderRole || requestedCountLabels.current.has(label)) return;
      const range = groupDateRange(label);
      if (!range) return;
      requestedCountLabels.current.add(label);
      void countBulkTriageTarget(bulkTriageTarget(accountScope, bulkFolderRole, range))
        .then((response) => setGroupCounts((current) => ({ ...current, [label]: response.count })))
        .catch(() => requestedCountLabels.current.delete(label));
    },
    [bulkFolderRole, accountScope],
  );

  const accountEmailById = useMemo(
    () => new Map((mailAccounts ?? []).map((account) => [account.id, account.emailAddress])),
    [mailAccounts],
  );

  /** "Done for 2 of 3 accounts — Personal needs reauth" (#67, #77's own acceptance line) — one rejected account's own share of a partial-failure toast. */
  const describeRejectedAccount = useCallback(
    (outcome: BulkTriageAccountOutcome): string => {
      const name = accountEmailById.get(outcome.mailAccountId) ?? outcome.mailAccountId;
      return outcome.reason === "needs_reauth" ? `${name} needs reauth` : name;
    },
    [accountEmailById],
  );

  const runGroupBulkAction = useCallback(
    (label: string, action: BulkTriageAction) => {
      if (!bulkFolderRole || accountScope.length === 0) return;
      const range = groupDateRange(label);
      if (!range) return; // Pinned/Undated: the cluster never renders for these (`VirtualizedThreadList`), so this is only a defensive no-op.
      const target = bulkTriageTarget(accountScope, bulkFolderRole, range);

      // Which *loaded* Threads belong to this group — for the optimistic
      // stagger/collapse only. The batch itself targets the true set
      // server-side (#67): an unloaded Thread is cleared right along with
      // these even though nothing here ever names it.
      const now = new Date();
      const groupThreadIds =
        action === "done"
          ? threads
              .filter(
                (thread) =>
                  !thread.pinned &&
                  timeGroupLabel(thread.lastMessageAt ?? thread.firstMessageAt, now) === label,
              )
              .map((thread) => thread.id)
          : [];

      if (groupThreadIds.length > 0) {
        setClearingThreadIds(new Set(groupThreadIds));
        const staggerRows = Math.min(groupThreadIds.length, GROUP_STAGGER_ROW_CAP);
        if (collapseTimer.current) clearTimeout(collapseTimer.current);
        collapseTimer.current = setTimeout(
          () => {
            setHiddenThreadIds((current) => new Set([...current, ...groupThreadIds]));
            setClearingThreadIds(new Set());
            collapseTimer.current = null;
          },
          GROUP_STAGGER_STEP_MS * staggerRows + GROUP_COLLAPSE_DURATION_MS,
        );
      }

      const batchId = generateUlid();
      void runBulkTriageBatch({ id: batchId, action, target })
        .then((response) => {
          requestSyncNow();
          const failed = response.accounts.filter((account) => account.status === "rejected");
          const verb = action === "done" ? "Done" : "Marked read";
          const message =
            failed.length === 0
              ? `${verb}: ${response.affectedCount} in ${label}.`
              : `${verb} for ${response.accounts.length - failed.length} of ${response.accounts.length} accounts — ${failed.map(describeRejectedAccount).join(", ")}.`;
          const undoable = action === "done" && response.affectedCount > 0;
          showGroupBulkToast({
            message,
            durationMs: undoable
              ? BULK_TRIAGE_UNDO_WINDOW_SECONDS * 1000
              : GROUP_BULK_MESSAGE_TOAST_MS,
            onUndo: undoable
              ? () => {
                  void undoBulkTriageBatch({ batchId: response.batchId }).then((undoResponse) => {
                    if (undoResponse.status === "undone") {
                      setHiddenThreadIds((current) => {
                        const next = new Set(current);
                        for (const id of groupThreadIds) next.delete(id);
                        return next;
                      });
                    }
                    requestSyncNow();
                  });
                }
              : undefined,
          });
        })
        .catch(() => {
          // Visibly returns to the list *and* raises a toast naming the
          // failure — `RollbackToast`'s own posture for a single Optimistic
          // Action, carried over to this path's own surface (#75, #77).
          if (collapseTimer.current) {
            clearTimeout(collapseTimer.current);
            collapseTimer.current = null;
          }
          setClearingThreadIds(new Set());
          setHiddenThreadIds((current) => {
            const next = new Set(current);
            for (const id of groupThreadIds) next.delete(id);
            return next;
          });
          showGroupBulkToast({
            message: `Couldn't clear ${label} — restored to the list.`,
            durationMs: GROUP_BULK_MESSAGE_TOAST_MS,
          });
        });
    },
    [bulkFolderRole, accountScope, threads, describeRejectedAccount],
  );

  const groupBulk: GroupBulkController | undefined = bulkFolderRole
    ? {
        countFor: (label) => groupCounts[label] ?? null,
        requestCount: requestGroupCount,
        onDoneAll: (label) => runGroupBulkAction(label, "done"),
        onMarkAllRead: (label) => runGroupBulkAction(label, "markRead"),
        clearingThreadIds,
      }
    : undefined;

  // The optimistic hide (#66, #77): a group's loaded Threads vanish from
  // the list the instant their collapse finishes, well before the next sync
  // round actually removes them from the Local Cache — `threads` itself
  // stays the real, unfiltered read so `triage`/keyboard nav below are
  // never quietly walking a shorter list than the one the rest of the app
  // still thinks is current.
  const visibleThreads = useMemo(
    () =>
      hiddenThreadIds.size === 0
        ? threads
        : threads.filter((thread) => !hiddenThreadIds.has(thread.id)),
    [threads, hiddenThreadIds],
  );
  // Split/List's own neighbor set (#97's bug 4): `visibleThreads` is what
  // they actually render, so their `ids` prop — the source `neighborId`
  // walks for "the reading pane's own back/forward" — has to name exactly
  // those rows too. Feeding it the unfiltered `ids` below let a Group Done
  // clear leave `j`/`k`/back landing on a Thread whose row had already
  // disappeared: "nothing open."
  const visibleIds = useMemo(() => visibleThreads.map((thread) => thread.id), [visibleThreads]);

  // Search (#51, `docs/search-ux-spec.md`): one hook owns the route, the
  // parse, the prefilter + server round trip and the merged result set;
  // MailSection's only job is feeding it this account and wiring its own
  // `useTriage` instance — the same "one shared hook so actions mean the
  // same thing" reasoning as the triage instance above, kept separate only
  // because a result's selection/neighbor set is a different list.
  const search = useSearchState(accountScope, mailAccounts ?? []);
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
  // The Palette's "Enter opens the top hit" (#100): opens a search hit in
  // the reading pane while the results view stays closed and the list pane
  // keeps showing whatever it already was — "Enter opens the top (or
  // arrow-selected) hit in Split", never the results view itself, which
  // only "See all results" opens. Derived straight off `search`'s own
  // selection rather than tracked separately, so it disappears on its own
  // once the hit falls out of `search.results` (a new query, say).
  const openedSearchThread = search.active
    ? null
    : (search.results.find((candidate) => candidate.id === search.selectedThreadId) ?? null);

  // Stream is suppressed and the view-mode pair muted while searching
  // (search-ux-spec.md §The surface) — `search.active` joins `composeId` in
  // disabling this hook's own keydown listener so a result row's `j`/`k`
  // (handled by `searchTriage` below) is the only scheme live at once. An
  // opened search hit (above) counts too: the reading pane it occupies
  // belongs to `searchTriage`, not the folder's own selection.
  const triage = useTriage({
    mailAccountId: accountId,
    threads,
    ids,
    selectedThreadId,
    onSelect: setSelectedThreadId,
    direction,
    autoAdvanceEnabled,
    shortcutsDisabled:
      composeId !== null || search.active || Boolean(openedSearchThread) || screenerOpen,
  });
  const rawSearchTriage = useTriage({
    mailAccountId: accountId,
    threads: search.results,
    ids: useMemo(() => search.results.map((thread) => thread.id), [search.results]),
    selectedThreadId: search.selectedThreadId,
    onSelect: search.select,
    direction,
    autoAdvanceEnabled,
    shortcutsDisabled:
      composeId !== null || !(search.active || Boolean(openedSearchThread)) || screenerOpen,
  });
  const searchTriage = wrapSearchTriage(rawSearchTriage, search.results, search.markActedOn);

  // The Command Palette (#79) and the Shortcut Sheet — two independent
  // overlays, at most one up at a time in practice (opening one while the
  // other's up just replaces it, no stacking logic needed).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  // Set right before a `/`-triggered `.focus()` call, so the search field's
  // own `onFocus` (below) can tell "the `/` fast path" apart from a mouse
  // click on the field itself — only the latter is the Palette's other
  // entry point (#79's issue text: "the header search field is its other
  // entry point"). A ref, not state: it has to be readable synchronously by
  // the very next `focus` event, ahead of any render.
  const suppressPaletteOnFocusRef = useRef(false);
  const focusSearchField = useCallback(() => {
    suppressPaletteOnFocusRef.current = true;
    searchInputRef.current?.focus();
  }, []);

  // ⌘K pressed outside `/mail` navigates here and leaves a one-shot request
  // behind (`router/RootLayout.tsx`, `global-open.ts`) — consumed once, on
  // mount, same as any other "arrived with an intent" flag in this file.
  useEffect(() => {
    if (consumeGlobalPaletteOpenRequest()) setPaletteOpen(true);
  }, []);

  // …and while it stays mounted, the header's own global search field
  // (#86, `router/RootLayout.tsx`) raises the same request from a route
  // that is already `/mail`, where no mount is coming to consume a flag.
  useEffect(() => subscribeGlobalPaletteOpen(openPalette), [openPalette]);

  // Whichever Thread is actually open right now — the ordinary Inbox
  // pairing, Search's own results-view selection, or an opened search hit
  // (#100), matching the same branch the JSX below already takes — is what
  // the Palette's Triage commands (and "back to list") act on; there is no
  // fourth, Palette-owned notion of "the current Thread".
  const activeSelectedThread = search.active
    ? (search.results.find((candidate) => candidate.id === search.selectedThreadId) ?? null)
    : (openedSearchThread ??
      threads.find((candidate) => candidate.id === selectedThreadId) ??
      null);
  const activeTriage = search.active || openedSearchThread ? searchTriage : triage;
  const backToList = useCallback(() => {
    if (search.active || openedSearchThread) search.select(null);
    else setSelectedThreadId(null);
  }, [search.active, search.select, openedSearchThread]);

  // `/`, `⌘K`/`Ctrl-K` and `?` — all three inert while typing elsewhere, the
  // composer's open, or the Screener's up (the same "not typing" guard
  // `useTriage`'s own scheme uses).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (composeId !== null || screenerOpen) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (event.key === "/" && !typing) {
        event.preventDefault();
        // Focusing is enough — `SearchField`'s own `onFocus` is what opens
        // search when it isn't already active (`SearchField`'s own doc
        // comment). Opening here too would double-push the route (two
        // `/search` history entries for one open), which then takes two
        // Back presses to leave.
        focusSearchField();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        openPalette();
        return;
      }
      if (event.key === "?" && !typing) {
        event.preventDefault();
        setShortcutSheetOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [composeId, screenerOpen, focusSearchField, openPalette]);

  if (!mailAccounts || mailAccounts.length === 0) return null;
  if (!page) return null;

  return (
    <section className="mail-section">
      {/* Mail's own search bar (#96): all that's left of `mail/TopBar.tsx`
          after Account Scope moved into the Hub, the label filter and
          Screener chip were dropped as redundant with the Sidebar's own
          Labels/Screener entries, and Stream's toggle moved to the Sidebar
          (`Sidebar.tsx`'s own doc comment) — a single field, not a row of
          view-mode controls, so this isn't "the Mail toolbar" the ticket's
          acceptance box says is gone. */}
      <div className="mail-search-bar">
        <SearchField
          search={{
            active: search.active,
            queryText: search.queryText,
            inputRef: searchInputRef,
            onChange: search.onFieldChange,
            onCommit: search.onCommit,
            onEsc: search.onEsc,
            onBackspaceEmpty: search.onBackspaceEmpty,
            // The header field's own click/focus (#79: "the header search
            // field is its other entry point" for the Palette) — unless it
            // was `/` that focused it a moment ago (`suppressPaletteOnFocusRef`
            // above), in which case this is the pre-#79 "just open search"
            // path, matching `search-integration.test.tsx`'s own `/`-driven
            // coverage exactly.
            onOpen: () => {
              if (suppressPaletteOnFocusRef.current) {
                suppressPaletteOnFocusRef.current = false;
                search.open(searchOrigin);
              } else {
                openPalette();
              }
            },
            recentSearches: search.recentSearches,
            onRunRecent: search.runRecent,
            onClearRecent: search.clearRecent,
          }}
        />
      </div>
      {/* Unmounted rather than merely hidden while the Screener is open: a
          `readScreenerSeenUntil` read only happens on mount/account change
          (`GatekeeperBanner`'s own doc comment), and `openScreener` just
          wrote a fresh cursor — remounting is what picks it up, so the
          banner doesn't still claim "unseen" for holds it was just shown. */}
      {!screenerOpen && <GatekeeperBanner accountScope={accountScope} onOpen={openScreener} />}
      <div className="mail-frame">
        <Sidebar
          folder={folder}
          onSelectFolder={selectFolder}
          labels={labelsForPicker}
          labelFilter={labelFilter}
          onSelectLabel={selectLabelFilter}
          onCompose={openCompose}
          screenerCount={screenerSenderCount}
          draftsCount={draftCompositions.length}
          streamMode={streamMode}
          onStreamMode={changeStreamMode}
        />
        <div className="mail-body">
          {screenerOpen && accountScope.length > 0 ? (
            <Screener accountScope={accountScope} onClose={closeScreener} />
          ) : search.active ? (
            <SearchResultsView
              viewMode={viewMode}
              state={search}
              triage={searchTriage}
              onReply={openReply}
              onMailtoLink={openMailto}
              accounts={mailAccounts}
              mailAccountId={accountId}
              accountScope={accountScope}
            />
          ) : openedSearchThread ? (
            // "Enter opens the top hit... in Split" (#100): forced to Split
            // regardless of `viewMode`/`streamMode`/the current folder — the
            // list pane below is still `visibleThreads`, untouched, with
            // nothing in it highlighted; only the reading pane shows the hit.
            <SplitView
              threads={visibleThreads}
              ids={visibleIds}
              complete={page.complete}
              selectedThreadId={null}
              selectedThreadOverride={openedSearchThread}
              onSelect={(id) => {
                search.select(null);
                setSelectedThreadId(id);
              }}
              onClearSelection={() => search.select(null)}
              onLoadMore={loadMore}
              triage={searchTriage}
              onReply={openReply}
              onMailtoLink={openMailto}
              density={density}
              groupBulk={groupBulk}
            />
          ) : folder === "drafts" ? (
            <DraftsView drafts={draftCompositions} onOpen={reopenCompose} />
          ) : streamMode ? (
            <StreamView
              threads={threads}
              ids={ids}
              selectedThreadId={selectedThreadId}
              onSelect={setSelectedThreadId}
              triage={triage}
              onReply={openReply}
              onMailtoLink={openMailto}
            />
          ) : viewMode === "split" ? (
            <SplitView
              threads={visibleThreads}
              ids={visibleIds}
              complete={page.complete}
              selectedThreadId={selectedThreadId}
              onSelect={setSelectedThreadId}
              onClearSelection={() => setSelectedThreadId(null)}
              onLoadMore={loadMore}
              triage={triage}
              onReply={openReply}
              onMailtoLink={openMailto}
              initialScrollThreadId={selectedThreadId}
              density={density}
              groupBulk={groupBulk}
            />
          ) : (
            <ListView
              threads={visibleThreads}
              ids={visibleIds}
              complete={page.complete}
              selectedThreadId={selectedThreadId}
              onSelect={setSelectedThreadId}
              onBack={() => setSelectedThreadId(null)}
              onLoadMore={loadMore}
              triage={triage}
              onReply={openReply}
              onMailtoLink={openMailto}
              initialScrollThreadId={selectedThreadId}
              density={density}
              groupBulk={groupBulk}
            />
          )}
        </div>
      </div>
      <SendFailureBanner mailAccountId={accountId} onOpen={reopenCompose} />
      <PendingSendBar mailAccountId={accountId} onReopen={reopenCompose} />
      <RollbackToast />
      <NewMailToast />
      <NotificationOfferBanner />
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        selectedThread={activeSelectedThread}
        triage={activeTriage}
        onReply={openReply}
        onCompose={openCompose}
        onBackToList={backToList}
        onOpenScreener={openScreener}
        screenerCount={screenerSenderCount}
        onFocusSearch={focusSearchField}
        onOpenShortcutSheet={() => setShortcutSheetOpen(true)}
        search={search}
        searchOrigin={searchOrigin}
        accounts={mailAccounts ?? []}
        accountScope={accountScope}
      />
      <ShortcutSheet open={shortcutSheetOpen} onClose={() => setShortcutSheetOpen(false)} />
      {composeId && accountId && (
        <Suspense fallback={null}>
          <Composer
            key={composeId}
            compositionId={composeId}
            mailAccounts={mailAccounts}
            defaultMailAccountId={accountId}
            fromChoices={composeFromChoices}
            onClose={closeCompose}
          />
        </Suspense>
      )}
    </section>
  );
}
