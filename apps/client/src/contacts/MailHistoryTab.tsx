import type { MailAccount } from "@mail/shared";
import type { RowExtra } from "../mail/VirtualizedThreadList.js";
import { VirtualizedThreadList } from "../mail/VirtualizedThreadList.js";
import { useMailHistory } from "./useMailHistory.js";

/**
 * The Person Page's Mail history tab (#217, `docs`'s own §Person Page mail
 * history): every address on the Contact (and its Linked Contacts, once
 * #222 gives that concept a shape — there is no such relation in the domain
 * model yet, so this searches the Contact's own addresses only for now),
 * across every Mail Account in Account Scope, rendered as the Reader's own
 * thread rows via `VirtualizedThreadList` — "one list renderer... search is
 * another list, not a second application" holds here too, this is the
 * Person Page's own copy of exactly what `SearchResultsView.tsx` already
 * draws for `POST /search`. No triage affordance (swipe/right-click) —
 * unlike the Reader or Search, acting on a Thread isn't this dialog's job;
 * `onOpenThread` is the one thing a row does, handing off to the Mail App
 * which owns everything past that.
 */
export function MailHistoryTab({
  addresses,
  accountScope,
  mailAccounts,
  onOpenThread,
}: {
  addresses: readonly string[];
  /** Mail Account ids in Account Scope (`useAccountScope.ts#deriveMailAccountScope`) — this dialog's own read of Scope, since `ContactDialog` isn't otherwise wired into Mail's. */
  accountScope: readonly string[];
  mailAccounts: readonly MailAccount[];
  onOpenThread: (threadId: string) => void;
}) {
  const history = useMailHistory(addresses, accountScope);
  const showAccountBadge = accountScope.length > 1;

  const getRowExtra = (thread: { id: string; mailAccountId: string }): RowExtra | undefined => {
    const display = history.displayById.get(thread.id);
    if (!display) return undefined;
    return {
      headline: display.headline,
      folderPill:
        display.folder && display.folder.role !== "inbox" && display.folder.name
          ? display.folder.name
          : null,
      gatekeeperBadge: display.gatekeeper,
      accountBadge: showAccountBadge
        ? (mailAccounts.find((account) => account.id === thread.mailAccountId)?.emailAddress ??
          null)
        : null,
    };
  };

  if (history.noAddresses) {
    return <p className="contact-dialog-empty">Add an email address to see this Contact's mail.</p>;
  }

  if (accountScope.length === 0) {
    return <p className="contact-dialog-empty">No Mail Account in Scope to search.</p>;
  }

  if (history.loading && history.results.length === 0) {
    return <p className="contact-dialog-empty">Searching…</p>;
  }

  if (history.offline && history.results.length === 0) {
    return <p className="contact-dialog-empty">Offline — mail history needs a connection.</p>;
  }

  if (history.results.length === 0) {
    return <p className="contact-dialog-empty">No mail with this Contact yet.</p>;
  }

  const footer = (
    <div className="search-foot">
      {history.hasMore ? (
        <button
          type="button"
          className="search-load-older"
          onClick={history.loadOlder}
          disabled={history.loadingOlder}
        >
          {history.loadingOlder ? "Loading…" : "Load older mail"}
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="contact-dialog-mail-history">
      <VirtualizedThreadList
        threads={history.results}
        complete
        selectedThreadId={null}
        onSelect={onOpenThread}
        group={false}
        footer={footer}
        getRowExtra={getRowExtra}
        keyboardDisabled
      />
    </div>
  );
}
