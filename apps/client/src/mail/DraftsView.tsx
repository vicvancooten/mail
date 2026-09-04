import type { MailAccount } from "@mail/shared";
import type { CachedComposition } from "../store/index.js";
import { discardComposition, undiscardComposition } from "../store/index.js";
import { ActionMenu } from "./actions/ActionMenu.js";
import { useActions } from "./actions/ActionsProvider.js";
import { withDraft } from "./actions/types.js";
import { announceUndoableAction } from "./undo-toast.js";

/**
 * The Drafts sidebar destination (#74, #101): every unsent Composition
 * across the current Account Scope
 * (`store/compositions.ts#useDraftCompositions`), newest-first. Not a
 * Thread view — a Draft has no Thread until it sends — so this is its own
 * small surface rather than another `ListView`/`SplitView` mode: one row per
 * Composition, click reopens it in the Composer (`MailSection.tsx`'s own
 * "one composer at a time" guard, unchanged).
 *
 * Each row carries the Action registry's right-click / long-press menu
 * (#94): Open and Delete, the same "menus never show unavailable actions"
 * and "destructive actions render apart, in danger ink" rules every other
 * row's menu follows (`registry.ts`'s `draft-open`/`draft-delete`). Delete
 * has no hover-cluster or row-check control of its own, the same deliberate
 * restraint `ThreadRow` gives Trash — reachable by right-click/long-press
 * alone.
 *
 * `accounts` is only ever consulted for the account badge, and only once
 * Scope spans more than one account (`ThreadRow`'s own `accountBadge` gives
 * the identical treatment to a cross-account search result) — a single
 * in-scope account renders exactly as it always has, no badge at all.
 */
export function DraftsView({
  drafts,
  onOpen,
  accounts = [],
}: {
  drafts: CachedComposition[];
  onOpen: (compositionId: string) => void;
  /** Every Mail Account in the current Account Scope — for the cross-account badge below. */
  accounts?: readonly MailAccount[];
}) {
  if (drafts.length === 0) {
    return (
      <div className="mail-empty-state" role="status">
        No drafts.
      </div>
    );
  }

  const showAccountBadge = accounts.length > 1;

  return (
    <div className="draft-list" role="listbox" aria-label="Drafts">
      {drafts.map((draft) => (
        <DraftRow
          key={draft.id}
          draft={draft}
          onOpen={() => onOpen(draft.id)}
          accountLabel={
            showAccountBadge
              ? (accounts.find((account) => account.id === draft.mailAccountId)?.emailAddress ??
                null)
              : null
          }
        />
      ))}
    </div>
  );
}

/**
 * Delete (#101, ADR-0012's "deletion is asymmetric"): fires the moment the
 * registry's `draft-delete` runs, the same "component wires the toast, the
 * store stays store" split `screener/Screener.tsx` already uses for
 * Deny/Block. `discardComposition`'s own optimistic write is what drops this
 * row out of `drafts` above — the Undo toast is purely about offering the
 * inverse, not about the row's own disappearance.
 */
function DraftRow({
  draft,
  onOpen,
  accountLabel,
}: {
  draft: CachedComposition;
  onOpen: () => void;
  accountLabel: string | null;
}) {
  const actions = useActions();
  const subject = draft.subject || "(no subject)";

  const onDelete = () => {
    void discardComposition(draft.id, draft.mailAccountId);
    announceUndoableAction("discard", () => {
      void undiscardComposition(draft.id, draft.mailAccountId);
    });
  };

  return (
    <ActionMenu
      ctx={actions ? withDraft(actions, { draft, onOpen, onDelete }) : null}
      asChild
      label={`Actions for "${subject}"`}
    >
      <button type="button" className="draft-row" role="option" onClick={onOpen}>
        <span className="subject">{subject}</span>
        {draft.to.length > 0 ? (
          <span className="sender">
            To: {draft.to.map((recipient) => recipient.name ?? recipient.address).join(", ")}
          </span>
        ) : null}
        {accountLabel ? <span className="account-badge">{accountLabel}</span> : null}
      </button>
    </ActionMenu>
  );
}
