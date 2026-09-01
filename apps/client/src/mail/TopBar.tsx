import type { Label, MailAccount } from "@mail/shared";
import { ArrowDown, ArrowUp, Columns2, Layers, List as ListIcon, Tag } from "lucide-react";
import { AccountSwitcher } from "./AccountSwitcher.js";
import type { ViewMode } from "./device-preferences.js";
import type { AdvanceDirection } from "./triage-preferences.js";

/**
 * The top bar: the Split/List segmented control, the Stream mode opt-in
 * toggle, the auto-advance direction toggle (#42), the filter-by-label
 * picker (#43, hidden until the account has at least one Label — no point
 * showing an empty filter), and the account switcher. Icons via
 * lucide-react, icon+label buttons in the shadcn convention — the
 * commitments `prototype/triage-loop-ui` settled on (its README), adopted
 * here without pulling in the full shadcn component library the real app
 * doesn't otherwise use.
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
  direction,
  onDirection,
  accounts,
  selectedAccountId,
  onSelectAccount,
  labels,
  labelFilter,
  onLabelFilter,
}: {
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  streamMode: boolean;
  onStreamMode: (enabled: boolean) => void;
  direction: AdvanceDirection;
  onDirection: (direction: AdvanceDirection) => void;
  accounts: MailAccount[];
  selectedAccountId: string | null;
  onSelectAccount: (id: string) => void;
  /** This account's Labels (#43) — the filter-by-label picker's data source. */
  labels: Label[];
  /** `null` is the ordinary Inbox; a Label id filters to Threads carrying it. */
  labelFilter: string | null;
  onLabelFilter: (labelId: string | null) => void;
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

      <div className="divider" />

      <button
        type="button"
        className="toggle"
        onClick={() => onDirection(direction === "older" ? "newer" : "older")}
        title="After archive/trash, which neighbor gets selected?"
      >
        {direction === "older" ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
        Next: {direction === "older" ? "Older" : "Newer"}
      </button>

      {labels.length > 0 ? (
        <>
          <div className="divider" />
          <label className="label-filter" title="Filter by label (#43)">
            <Tag size={14} />
            <select
              value={labelFilter ?? ""}
              onChange={(event) => onLabelFilter(event.target.value || null)}
              aria-label="Filter by label"
            >
              <option value="">All mail</option>
              {labels.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}

      <div className="topbar-spacer" />

      <AccountSwitcher
        accounts={accounts}
        selectedId={selectedAccountId}
        onSelect={onSelectAccount}
      />
    </div>
  );
}
