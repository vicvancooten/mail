import type { MailAccount } from "@mail/shared";
import { Columns2, Layers, List as ListIcon } from "lucide-react";
import { AccountSwitcher } from "./AccountSwitcher.js";
import type { ViewMode } from "./device-preferences.js";

/**
 * The top bar: the Split/List segmented control, the Stream mode opt-in
 * toggle, and the account switcher. Icons via lucide-react, icon+label
 * buttons in the shadcn convention — the commitments `prototype/triage-loop-ui`
 * settled on (its README), adopted here without pulling in the full shadcn
 * component library the real app doesn't otherwise use.
 *
 * Stream mode is deliberately not a third segmented option: it replaces
 * whichever of Split/List is showing, and that underlying choice stays
 * selectable (dimmed) so turning Stream off returns to it.
 */
export function TopBar({
  viewMode,
  onViewMode,
  streamMode,
  onStreamMode,
  accounts,
  selectedAccountId,
  onSelectAccount,
}: {
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  streamMode: boolean;
  onStreamMode: (enabled: boolean) => void;
  accounts: MailAccount[];
  selectedAccountId: string | null;
  onSelectAccount: (id: string) => void;
}) {
  return (
    <div className="mail-topbar">
      <div className={`segmented${streamMode ? " muted" : ""}`}>
        <button
          type="button"
          className={viewMode === "split" ? "active" : ""}
          onClick={() => onViewMode("split")}
          title="Split view"
        >
          <Columns2 size={14} /> Split
        </button>
        <button
          type="button"
          className={viewMode === "list" ? "active" : ""}
          onClick={() => onViewMode("list")}
          title="List view"
        >
          <ListIcon size={14} /> List
        </button>
      </div>

      <div className="divider" />

      <button
        type="button"
        className={`toggle${streamMode ? " on" : ""}`}
        onClick={() => onStreamMode(!streamMode)}
        title="Opt-in: replaces Split/List with one-thread-at-a-time browsing"
      >
        <Layers size={14} /> Stream mode
      </button>

      <div className="topbar-spacer" />

      <AccountSwitcher
        accounts={accounts}
        selectedId={selectedAccountId}
        onSelect={onSelectAccount}
      />
    </div>
  );
}
