import type { CachedComposition } from "../store/index.js";

/**
 * The Drafts sidebar destination (#74): every unsent Composition
 * (`store/compositions.ts#useDraftCompositions`), newest-first. Not a Thread
 * view — a Draft has no Thread until it sends — so this is its own small
 * surface rather than another `ListView`/`SplitView` mode: one row per
 * Composition, click reopens it in the Composer (`MailSection.tsx`'s own
 * "one composer at a time" guard, unchanged).
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
        <button
          key={draft.id}
          type="button"
          className="draft-row"
          role="option"
          onClick={() => onOpen(draft.id)}
        >
          <span className="subject">{draft.subject || "(no subject)"}</span>
          {draft.to.length > 0 ? (
            <span className="sender">
              To: {draft.to.map((recipient) => recipient.name ?? recipient.address).join(", ")}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
