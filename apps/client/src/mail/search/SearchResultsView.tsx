import type { MailAccount } from "@mail/shared";
import { useState } from "react";
import { Pictogram } from "../../brand/Pictogram.js";
import { ReauthMailAccountForm } from "../../mail-accounts/ReauthMailAccountForm.js";
import type { OnReply } from "../ThreadDetailPane.js";
import { ThreadDetailPane } from "../ThreadDetailPane.js";
import type { Triage } from "../useTriage.js";
import type { RowExtra } from "../VirtualizedThreadList.js";
import { VirtualizedThreadList } from "../VirtualizedThreadList.js";
import { formatFolderLabel, seededScopeHint } from "./scope.js";
import { formatIndexWatermark, type SearchState } from "./useSearchState.js";

function formatWatermark(state: SearchState): string | null {
  return formatIndexWatermark(state.indexWatermark);
}

/**
 * The chip row (#51, `docs/search-ux-spec.md` §The chip row): "the only
 * place that states what this search covers... every chip is driven off
 * the parse, never off separate state." Every chip here reads
 * `SearchState` and edits `?q=` through it — there is no chip-local state.
 */
function ChipRow({
  state,
  accounts,
  mailAccountId,
}: {
  state: SearchState;
  accounts: readonly MailAccount[];
  mailAccountId: string | null;
}) {
  const account = accounts.find((candidate) => candidate.id === mailAccountId);
  const scopeLabel = state.effectiveFolder
    ? formatFolderLabel(state.effectiveFolder)
    : state.effectiveLabel
      ? state.effectiveLabel
      : "All mail";
  const trashJunkOn =
    state.effectiveFolder?.toLowerCase() === "trash" ||
    state.effectiveFolder?.toLowerCase() === "junk";
  const hint = state.seedLive ? seededScopeHint(state.seed) : null;

  return (
    <div className="search-chip-row">
      {accounts.length > 1 && account ? (
        <span className="search-chip search-chip-account">{account.emailAddress}</span>
      ) : null}

      <span
        className={`search-chip search-chip-scope${state.seedLive ? " seeded" : ""}`}
        title={hint ?? undefined}
      >
        {scopeLabel}
        {state.effectiveFolder || state.effectiveLabel ? (
          <button
            type="button"
            className="search-chip-remove"
            title="Search all mail"
            onClick={() => {
              if (state.seedLive) state.popSeed();
              else if (state.parsed.folder) state.setOperator("in", null);
              else if (state.parsed.label) state.setOperator("label", null);
            }}
          >
            <Pictogram name="close" size={11} />
          </button>
        ) : null}
      </span>

      <button
        type="button"
        className={`search-chip search-chip-toggle${trashJunkOn ? " on" : ""}`}
        onClick={state.toggleTrashJunk}
      >
        Trash & Junk
      </button>

      {state.parsed.from ? (
        <span className="search-chip">
          From: {state.parsed.from}
          <button
            type="button"
            className="search-chip-remove"
            onClick={() => state.setOperator("from", null)}
          >
            <Pictogram name="close" size={11} />
          </button>
        </span>
      ) : null}
      {state.parsed.to ? (
        <span className="search-chip">
          To: {state.parsed.to}
          <button
            type="button"
            className="search-chip-remove"
            onClick={() => state.setOperator("to", null)}
          >
            <Pictogram name="close" size={11} />
          </button>
        </span>
      ) : null}
      {state.parsed.hasAttachment ? (
        <span className="search-chip">
          Has attachment
          <button
            type="button"
            className="search-chip-remove"
            onClick={() => state.setOperator("has", null)}
          >
            <Pictogram name="close" size={11} />
          </button>
        </span>
      ) : null}
      {state.parsed.after ? (
        <span className="search-chip">
          After: {state.parsed.after}
          <button
            type="button"
            className="search-chip-remove"
            onClick={() => state.setOperator("after", null)}
          >
            <Pictogram name="close" size={11} />
          </button>
        </span>
      ) : null}
      {state.parsed.before ? (
        <span className="search-chip">
          Before: {state.parsed.before}
          <button
            type="button"
            className="search-chip-remove"
            onClick={() => state.setOperator("before", null)}
          >
            <Pictogram name="close" size={11} />
          </button>
        </span>
      ) : null}
    </div>
  );
}

function EmptyState({ state }: { state: SearchState }) {
  const watermark = formatWatermark(state);
  const parts: string[] = [];
  if (state.parsed.text) parts.push(`"${state.parsed.text}"`);
  if (state.parsed.from) parts.push(`From: ${state.parsed.from}`);
  if (state.parsed.to) parts.push(`To: ${state.parsed.to}`);
  if (state.effectiveFolder) parts.push(`In: ${formatFolderLabel(state.effectiveFolder)}`);
  if (state.effectiveLabel) parts.push(`Label: ${state.effectiveLabel}`);

  return (
    <div className="search-empty">
      <p>No matches{parts.length > 0 ? ` for ${parts.join(", ")}` : ""}.</p>
      {state.effectiveFolder && state.effectiveFolder.toLowerCase() !== "inbox" ? (
        <button type="button" onClick={() => state.setOperator("in", null)}>
          Search all folders
        </button>
      ) : null}
      {state.parsed.from ? (
        <button type="button" onClick={() => state.setOperator("from", null)}>
          Remove From: {state.parsed.from}
        </button>
      ) : null}
      {/* "the promoted watermark line" (spec §The foot of the list) — zero results is the one place it moves out of the foot. */}
      {watermark ? <p className="search-watermark promoted">{watermark}</p> : null}
    </div>
  );
}

/**
 * The `Needs Reauth` degraded-state banner (`docs/search-ux-spec.md`
 * §Offline/degraded states: "a banner reading 'Reconnect &lt;account&gt; to
 * search all mail' with a reconnect button and no background retry loop").
 * Reuses `ReauthMailAccountForm` — the same re-enter-credentials flow
 * `MailAccountsSection` already surfaces in Settings — rather than growing a
 * second implementation of it; navigating away to Settings would drop the
 * User out of the results they were just looking at (#71's Settings route
 * is a fine place to *reach* this flow from, a bad place to be *sent* to
 * mid-search), so the button reveals the same form inline instead.
 * `state.needsReauth` flips (and this banner disappears on its
 * own) once the Local Cache's own Mail Account row catches up, so there is
 * nothing else for `onResumed` to do beyond collapsing the form.
 */
function ReauthBanner({ account }: { account: MailAccount | null }) {
  const [reconnecting, setReconnecting] = useState(false);
  const label = account?.emailAddress ?? "this account";

  return (
    <div className="search-reauth-banner">
      <p>Reconnect {label} to search all mail</p>
      {reconnecting && account ? (
        <ReauthMailAccountForm
          mailAccountId={account.id}
          onResumed={() => setReconnecting(false)}
        />
      ) : (
        <button
          type="button"
          className="search-reauth-button"
          onClick={() => setReconnecting(true)}
          disabled={!account}
        >
          Reconnect
        </button>
      )}
    </div>
  );
}

export function SearchResultsView({
  viewMode,
  state,
  triage,
  onReply,
  accounts,
  mailAccountId,
}: {
  viewMode: "split" | "list";
  state: SearchState;
  triage: Triage;
  onReply: OnReply;
  accounts: readonly MailAccount[];
  mailAccountId: string | null;
}) {
  const selectedThread =
    state.results.find((thread) => thread.id === state.selectedThreadId) ?? null;
  const watermark = formatWatermark(state);
  const account = accounts.find((candidate) => candidate.id === mailAccountId) ?? null;

  const getRowExtra = (thread: { id: string }): RowExtra | undefined => {
    const display = state.displayById.get(thread.id);
    if (!display) return undefined;
    const overlaid = state.results.find((candidate) => candidate.id === thread.id);
    return {
      headline: display.headline,
      folderPill:
        display.folder && display.folder.role !== "inbox" && display.folder.name
          ? display.folder.name
          : null,
      actionBadge:
        state.actedOnThreadIds.has(thread.id) && overlaid && !overlaid.inInbox ? "Removed" : null,
      gatekeeperBadge: display.gatekeeper,
    };
  };

  // Persistent regardless of result count (`docs/search-ux-spec.md`
  // §Offline/degraded states: "a persistent strip") — the Local Cache
  // prefilter can legitimately come back empty while offline or Needs
  // Reauth, and the banner must still say so rather than vanish.
  const degradedBanner = state.offline ? (
    <p className="search-offline-banner">Offline — searching recent mail only</p>
  ) : state.needsReauth ? (
    <ReauthBanner account={account} />
  ) : null;

  // Only the parts that make sense alongside actual rows — "load older" and
  // the inline watermark — stay gated on `results.length`; the degraded
  // banner itself does not.
  const footer =
    state.results.length === 0 ? null : (
      <div className="search-foot">
        {degradedBanner ??
          (state.hasMore ? (
            <button
              type="button"
              className="search-load-older"
              onClick={state.loadOlder}
              disabled={state.loadingOlder}
            >
              {state.loadingOlder ? "Loading…" : "Load older results"}
            </button>
          ) : null)}
        {watermark && !state.offline ? <p className="search-watermark">{watermark}</p> : null}
      </div>
    );

  const list =
    !state.meetsFloor && state.queryText.trim().length > 0 ? (
      <p className="mail-empty">Keep typing — search starts at 3 characters.</p>
    ) : state.results.length === 0 ? (
      <>
        <EmptyState state={state} />
        {degradedBanner ? <div className="search-foot">{degradedBanner}</div> : null}
      </>
    ) : (
      <VirtualizedThreadList
        threads={state.results}
        complete
        selectedThreadId={state.selectedThreadId}
        onSelect={state.select}
        triage={triage}
        group={false}
        footer={footer}
        getRowExtra={getRowExtra}
      />
    );

  if (viewMode === "list" && selectedThread) {
    return (
      <ThreadDetailPane
        key={selectedThread.id}
        thread={selectedThread}
        onBack={() => state.select(null)}
        triage={triage}
        onReply={onReply}
        focusMessageId={state.displayById.get(selectedThread.id)?.matchedMessageId}
      />
    );
  }

  if (viewMode === "list") {
    return (
      <div className="search-results-view search-results-list">
        <ChipRow state={state} accounts={accounts} mailAccountId={mailAccountId} />
        {list}
      </div>
    );
  }

  return (
    <div className={`split-view search-results-view${selectedThread ? " has-selection" : ""}`}>
      <div className="split-list">
        <ChipRow state={state} accounts={accounts} mailAccountId={mailAccountId} />
        {list}
      </div>
      <div className="split-pane">
        {selectedThread ? (
          <ThreadDetailPane
            key={selectedThread.id}
            thread={selectedThread}
            onBack={() => state.select(null)}
            triage={triage}
            onReply={onReply}
            focusMessageId={state.displayById.get(selectedThread.id)?.matchedMessageId}
          />
        ) : (
          <p className="mail-empty">Select a result to read it.</p>
        )}
      </div>
    </div>
  );
}
