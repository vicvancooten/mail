import { Ban, Check, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  enqueueMutation,
  type ScreenerSenderGroup,
  useScreenerSenders,
} from "../../store/index.js";

/**
 * The Screener screen (#56, poc-spec.md §Gatekeeper v1): "lists held
 * *senders*: Approve (release, original dates) / Deny (trash, stays
 * Unscreened) / Block (trash + all future mail moved to `\Trash` on
 * arrival)." One row per stranger, oldest hold first — a queue to work
 * through, not a ranked list (`store/reads.ts#readScreenerSenders`).
 *
 * Every decision fires `enqueueMutation` with an `address`-scoped sender —
 * the row it targets disappears the instant the Optimistic Action is
 * queued (`store/reads.ts`'s own overlay), before any round trip. The
 * domain-scoped "overflow convenience" poc-spec.md also describes is not
 * wired to a button here — every row this Client can show already names one
 * real address, and offering a domain-wide Block from a single stranger's
 * row risks blocking far more people than the User meant to; a future pass
 * can add it once there is a place to show "these N senders share a
 * domain" honestly.
 *
 * No `useTriage` here — the Inbox's actions (archive, star, ...) mean
 * nothing to a sender the User has never let through the gate yet, so this
 * screen owns its own small keyboard scheme instead of stretching that
 * hook to cover a shape it was never about.
 */
export function Screener({
  mailAccountId,
  onClose,
}: {
  mailAccountId: string;
  onClose: () => void;
}) {
  const groups = useScreenerSenders(mailAccountId) ?? [];
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  // Keep the keyboard selection valid as decisions remove rows out from
  // under it — falls back to the new first row, or clears once the queue is
  // empty, rather than pointing at a sender that just left the list.
  useEffect(() => {
    if (groups.length === 0) {
      setSelectedAddress(null);
      return;
    }
    if (!selectedAddress || !groups.some((group) => group.address === selectedAddress)) {
      setSelectedAddress(groups[0]?.address ?? null);
    }
  }, [groups, selectedAddress]);

  const decide = useCallback(
    (type: "approveSender" | "denySender" | "blockSender", address: string) => {
      void enqueueMutation({ type, sender: { scope: "address", value: address } }, mailAccountId);
    },
    [mailAccountId],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (groups.length === 0) return;
      const index = groups.findIndex((group) => group.address === selectedAddress);

      switch (event.key) {
        case "j":
        case "ArrowDown": {
          event.preventDefault();
          const next = groups[index + 1] ?? groups[0];
          if (next) setSelectedAddress(next.address);
          return;
        }
        case "k":
        case "ArrowUp": {
          event.preventDefault();
          const prev = index > 0 ? groups[index - 1] : groups[groups.length - 1];
          if (prev) setSelectedAddress(prev.address);
          return;
        }
        case "a":
          if (selectedAddress) decide("approveSender", selectedAddress);
          return;
        case "d":
          if (selectedAddress) decide("denySender", selectedAddress);
          return;
        case "b":
          if (selectedAddress) decide("blockSender", selectedAddress);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [groups, selectedAddress, onClose, decide]);

  return (
    <section className="screener" aria-label="Screener">
      <div className="screener-header">
        <h2>Screener</h2>
        <button type="button" className="screener-close" onClick={onClose}>
          Back to Inbox
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="mail-empty">Nothing waiting — new strangers show up here.</p>
      ) : (
        <ul className="screener-list" aria-label="Held senders">
          {groups.map((group) => (
            <ScreenerRow
              key={group.address}
              group={group}
              selected={group.address === selectedAddress}
              onSelect={() => setSelectedAddress(group.address)}
              onApprove={() => decide("approveSender", group.address)}
              onDeny={() => decide("denySender", group.address)}
              onBlock={() => decide("blockSender", group.address)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ScreenerRow({
  group,
  selected,
  onSelect,
  onApprove,
  onDeny,
  onBlock,
}: {
  group: ScreenerSenderGroup;
  selected: boolean;
  onSelect: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onBlock: () => void;
}) {
  return (
    <li
      className={`screener-row${selected ? " selected" : ""}`}
      onMouseEnter={onSelect}
      aria-label={group.name ?? group.address}
    >
      <div className="screener-row-sender">
        <span className="screener-row-name">{group.name ?? group.address}</span>
        {group.name ? <span className="screener-row-address">{group.address}</span> : null}
        {group.threadCount > 1 ? (
          <span className="screener-row-count">{group.threadCount} conversations</span>
        ) : null}
      </div>
      <div className="screener-row-peek">
        <span className="screener-row-subject">{group.subject || "(no subject)"}</span>
        {group.snippet ? <span className="screener-row-snippet">{group.snippet}</span> : null}
      </div>
      <div className="screener-row-actions">
        <button type="button" className="screener-approve" onClick={onApprove} title="Approve (a)">
          <Check size={14} /> Approve
        </button>
        <button type="button" className="screener-deny" onClick={onDeny} title="Deny (d)">
          <X size={14} /> Deny
        </button>
        <button type="button" className="screener-block" onClick={onBlock} title="Block (b)">
          <Ban size={14} /> Block
        </button>
      </div>
    </li>
  );
}
