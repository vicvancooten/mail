import type { CachedComposition } from "../store/index.js";
import { ActionMenu } from "./actions/ActionMenu.js";
import { useActions } from "./actions/ActionsProvider.js";
import { withDraft } from "./actions/types.js";

/**
 * The Drafts sidebar destination (#74): every unsent Composition
 * (`store/compositions.ts#useDraftCompositions`), newest-first. Not a Thread
 * view — a Draft has no Thread until it sends — so this is its own small
 * surface rather than another `ListView`/`SplitView` mode: one row per
 * Composition, click reopens it in the Composer (`MailSection.tsx`'s own
 * "one composer at a time" guard, unchanged).
 *
 * Each row carries the Action registry's right-click / long-press menu
 * (#94) like every other row in the Client. Today that menu holds one
 * entry, Open draft: deleting a Draft has no path in the Client yet, and
 * #101 is the ticket asked to give it one — a second answer invented here
 * would be exactly the duplication this registry exists to end.
 */
export function DraftsView({
  drafts,
  onOpen,
}: {
  drafts: CachedComposition[];
  onOpen: (compositionId: string) => void;
}) {
  if (drafts.length === 0) {
    return (
      <div className="mail-empty-state" role="status">
        No drafts.
      </div>
    );
  }

  return (
    <div className="draft-list" role="listbox" aria-label="Drafts">
      {drafts.map((draft) => (
        <DraftRow key={draft.id} draft={draft} onOpen={() => onOpen(draft.id)} />
      ))}
    </div>
  );
}

function DraftRow({ draft, onOpen }: { draft: CachedComposition; onOpen: () => void }) {
  const actions = useActions();
  const subject = draft.subject || "(no subject)";
  return (
    <ActionMenu
      ctx={actions ? withDraft(actions, { draft, onOpen }) : null}
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
      </button>
    </ActionMenu>
  );
}
