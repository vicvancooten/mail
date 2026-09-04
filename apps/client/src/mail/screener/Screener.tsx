import type { GatekeeperSender } from "@mail/shared";
import { senderDomain } from "@mail/shared";
import { ArrowLeft, Eye } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  enqueueMutation,
  type ScreenerSenderGroup,
  useScreenerSenders,
} from "../../store/index.js";
import { Avatar } from "../Avatar.js";
import { ActionMenu } from "../actions/ActionMenu.js";
import { useActions } from "../actions/ActionsProvider.js";
import { withScreenerSender } from "../actions/types.js";
import { announceUndoableAction } from "../undo-toast.js";
import { BlockAliasDialog } from "./BlockAliasDialog.js";
import { ScreenerActions } from "./ScreenerActions.js";
import { ScreenerViewDialog } from "./ScreenerViewDialog.js";

/**
 * The Screener screen (#56, #102, poc-spec.md §Gatekeeper v1): "lists held
 * *senders*: Approve (release, original dates) / Deny (trash, stays
 * Unscreened) / Block (trash + all future mail moved to `\Trash` on
 * arrival)." One row per stranger, oldest hold first — a queue to work
 * through, not a ranked list (`store/reads.ts#readScreenerSenders`).
 *
 * Grouped by Mail Account across Account Scope (#82, #73): each account's
 * cluster is oldest-first on its own, and clusters themselves stay in
 * Scope's own order — the primary account's cluster leads. A group header
 * only shows once Scope actually holds more than one account; a single
 * account's Screener reads exactly as it always has, no header standing
 * over a list that has nothing to disambiguate.
 *
 * Every decision fires `enqueueMutation` — the row it targets disappears the
 * instant the Optimistic Action is queued (`store/reads.ts`'s own overlay),
 * before any round trip. `#102`'s grill wired the domain-scoped "overflow
 * convenience" poc-spec.md describes: Block's split menu (`ScreenerActions.
 * tsx`) offers *Block domain*, resolving the row's own address to its domain
 * (`blockDomain` below) rather than requiring a place that shows "these N
 * senders share a domain" first, and *Mark as spam* (CONTEXT.md's Spam) —
 * both a deliberate extra click behind Block's own default, never it.
 *
 * View (#102) opens `ScreenerViewDialog` on a row's held Threads, read
 * through the ordinary sandboxed reader with images blocked and links inert
 * — see that module's own doc comment for how deciding from inside it closes
 * the dialog for free.
 *
 * #103's Block Alias rides the same split menu, `{scope: "recipient"}`
 * instead of `{scope: "domain"}` — but it is the one entry that doesn't
 * decide on select: it opens `BlockAliasDialog`'s confirmation first (the
 * ticket's own "behind a confirmation that names the exact Alias"), and only
 * `confirmBlockAlias` below actually calls `decide`.
 *
 * No `useTriage` here — the Inbox's actions (archive, star, ...) mean
 * nothing to a sender the User has never let through the gate yet, so this
 * screen owns its own small keyboard scheme instead of stretching that
 * hook to cover a shape it was never about. That is also why the Action
 * registry's three Screener entries are marked contextual (#94): this is a
 * modal surface holding the whole keyboard while it is up, so its `a`/`d`/
 * `b` stay bound here rather than by the registry's global listener — the
 * registry's part is that every row gets the same right-click / long-press
 * menu every other row in the Client has, with the same keycaps printed on
 * it.
 */
/** How long a decided slip stays on screen carrying its verdict before it clears. */
const VERDICT_HOLD_MS = 900;

/** A sender's identity within the Screener's own selection and verdict bookkeeping — an address alone collides once two Mail Accounts share Scope. */
function rowKey(group: Pick<ScreenerSenderGroup, "mailAccountId" | "address">): string {
  return `${group.mailAccountId}:${group.address}`;
}

export function Screener({
  accountScope,
  onClose,
}: {
  accountScope: readonly string[];
  onClose: () => void;
}) {
  const accountGroups = useScreenerSenders(accountScope) ?? [];
  // Flattened in display order — group headers are a rendering concern only;
  // keyboard nav and selection walk the same queue whether or not a header
  // happens to be drawn above the row it's crossing into.
  const groups = accountGroups.flatMap((account) => account.senders);
  const showAccountHeaders = accountScope.length > 1;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Keep the keyboard selection valid as decisions remove rows out from
  // under it — falls back to the new first row, or clears once the queue is
  // empty, rather than pointing at a sender that just left the list.
  useEffect(() => {
    if (groups.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !groups.some((group) => rowKey(group) === selectedKey)) {
      const first = groups[0];
      setSelectedKey(first ? rowKey(first) : null);
    }
  }, [groups, selectedKey]);

  /**
   * Senders that have just been decided. The Optimistic Action is queued
   * immediately and `store/reads.ts`'s overlay drops the sender from
   * `groups` on the same tick, so this holds the slip's last known state for
   * long enough to say what happened to it before it clears. Nothing is
   * delayed: the write has already happened, and this layer is purely what
   * you see it happen as.
   */
  const [decided, setDecided] = useState<{ group: ScreenerSenderGroup; verdict: string }[]>([]);

  /**
   * The View dialog's own target (#102) — a row key, not the group object
   * itself, so it stays a live lookup against `groups` below rather than a
   * snapshot: the group it names simply stops existing once a decision is
   * queued for it, which is what closes the dialog (see
   * `ScreenerViewDialog.tsx`'s own doc comment).
   */
  const [viewingKey, setViewingKey] = useState<string | null>(null);
  const viewingGroup = groups.find((group) => rowKey(group) === viewingKey) ?? null;

  /**
   * Block Alias's own confirmation target (#103) — the same live-lookup row
   * key `viewingKey` uses just above, for the same reason: if a decision
   * lands on this sender from elsewhere while the confirmation is open (the
   * View dialog's own actions, a keyboard shortcut), the row disappears out
   * from under it and `BlockAliasDialog` closes for free rather than
   * confirming against a group that no longer exists.
   */
  const [confirmingAliasKey, setConfirmingAliasKey] = useState<string | null>(null);
  const confirmingAliasGroup = groups.find((group) => rowKey(group) === confirmingAliasKey) ?? null;

  /**
   * `sender` overrides the default address-scoped target (#102's Block
   * domain, `{scope:"domain", value}`) — every other decision keeps naming
   * the row's own address, exactly as before.
   */
  const decide = useCallback(
    (
      type: "approveSender" | "denySender" | "blockSender" | "spamSender",
      group: ScreenerSenderGroup,
      sender?: GatekeeperSender,
    ) => {
      // Bound once so Undo (#95) reverses the *same* target the decision
      // used — #102's Block domain passes `{scope:"domain"}`, everything
      // else names the row's own address.
      const decidedSender: GatekeeperSender = sender ?? { scope: "address", value: group.address };
      void enqueueMutation({ type, sender: decidedSender }, group.mailAccountId);
      const verdict =
        type === "approveSender"
          ? "Approved"
          : type === "blockSender"
            ? "Blocked"
            : type === "spamSender"
              ? "Spam"
              : "Returned";
      setDecided((current) => [...current, { group, verdict }]);
      const key = rowKey(group);
      window.setTimeout(
        () => setDecided((current) => current.filter((row) => rowKey(row.group) !== key)),
        VERDICT_HOLD_MS,
      );

      // Undo (#95, ADR-0019): Deny, Block, and Mark as spam are the three
      // undoable Screener decisions — Approve isn't (CONTEXT.md's Undo entry
      // doesn't list it, and releasing a stranger's mail needs no second
      // thoughts the way trashing it does). `group.threadIds` is exactly
      // what this sender is holding *right now*, captured before the
      // decision so Undo still names the right Threads however long the
      // toast's window runs — by the time it fires this sender may be
      // holding a fresh stranger's mail again.
      //
      // Spam folds into the "block" toast kind rather than a `"spam"` one
      // of its own: `undo-toast.ts`'s `UndoableActionKind` union and its
      // `LABELS` table are a second fix worker's own surface this batch
      // (see this branch's own PR description), so this reuses the kind
      // whose *reversal* is byte-for-byte identical — Spam's Verdict is a
      // Blocked one (`spam: true` alongside it, CONTEXT.md's Spam) — rather
      // than adding a fourth kind there. The one visible cost is the toast
      // reading "Blocked" for a Spam decision rather than a Spam-specific
      // label; the reversal itself (`unblockAndRestore`, which now also
      // pulls a Thread back out of Junk) is the part #102's Acceptance box
      // actually asks for.
      if (type === "denySender" || type === "blockSender" || type === "spamSender") {
        announceUndoableAction(type === "denySender" ? "deny" : "block", () => {
          void enqueueMutation(
            { type: "unblockAndRestore", sender: decidedSender, threadIds: group.threadIds },
            group.mailAccountId,
          );
        });
      }
    },
    [],
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
        // The View dialog owns Escape while it's open — one press backs out
        // of it, not all the way to the Inbox.
        if (viewingKey !== null) setViewingKey(null);
        else onClose();
        return;
      }
      // The dialog is modal; its own keyboard handling (Radix) takes over
      // while it's open, so the Screener's j/k/a/d/b scheme stays quiet.
      if (viewingKey !== null) return;
      if (groups.length === 0) return;
      const index = groups.findIndex((group) => rowKey(group) === selectedKey);
      const selected = index >= 0 ? groups[index] : null;

      switch (event.key) {
        case "j":
        case "ArrowDown": {
          event.preventDefault();
          const next = groups[index + 1] ?? groups[0];
          if (next) setSelectedKey(rowKey(next));
          return;
        }
        case "k":
        case "ArrowUp": {
          event.preventDefault();
          const prev = index > 0 ? groups[index - 1] : groups[groups.length - 1];
          if (prev) setSelectedKey(rowKey(prev));
          return;
        }
        case "a":
          if (selected) decide("approveSender", selected);
          return;
        case "d":
          if (selected) decide("denySender", selected);
          return;
        case "b":
          if (selected) decide("blockSender", selected);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [groups, selectedKey, onClose, decide, viewingKey]);

  /** Block domain (#102): resolves the row's own address to its domain and decides with that scope instead of the default address one. */
  function blockDomain(group: ScreenerSenderGroup): void {
    const domain = senderDomain(group.address);
    if (domain) decide("blockSender", group, { scope: "domain", value: domain });
  }

  /** Block Alias (#103): opens the confirmation rather than deciding directly — see `confirmingAliasKey`'s own doc comment. */
  function blockAlias(group: ScreenerSenderGroup): void {
    if (group.alias) setConfirmingAliasKey(rowKey(group));
  }

  /** The confirmation's own Confirm button: only now does Block Alias actually decide, `{scope: "recipient"}` naming the Alias itself. */
  function confirmBlockAlias(): void {
    if (confirmingAliasGroup?.alias) {
      decide("blockSender", confirmingAliasGroup, {
        scope: "recipient",
        value: confirmingAliasGroup.alias,
      });
    }
    setConfirmingAliasKey(null);
  }

  return (
    <section className="screener" aria-label="Screener">
      <div className="screener-header">
        <h2>Screener</h2>
        {groups.length > 0 ? <span className="screener-count">{groups.length}</span> : null}
        <button type="button" className="screener-close" onClick={onClose}>
          <ArrowLeft size={14} /> Back to Inbox
        </button>
      </div>

      {groups.length === 0 && decided.length === 0 ? (
        <p className="mail-empty">Nothing waiting — new strangers show up here.</p>
      ) : (
        <ul className="screener-list" aria-label="Held senders">
          {accountGroups.map((account) => (
            <li key={account.mailAccountId} className="screener-group">
              {showAccountHeaders ? (
                <div className="screener-group-header">{account.accountEmail}</div>
              ) : null}
              <ul className="screener-group-rows">
                {account.senders.map((group) => (
                  <ScreenerRow
                    key={rowKey(group)}
                    group={group}
                    selected={rowKey(group) === selectedKey}
                    onSelect={() => setSelectedKey(rowKey(group))}
                    onView={() => setViewingKey(rowKey(group))}
                    onApprove={() => decide("approveSender", group)}
                    onDeny={() => decide("denySender", group)}
                    onBlock={() => decide("blockSender", group)}
                    onBlockDomain={() => blockDomain(group)}
                    onSpam={() => decide("spamSender", group)}
                    onBlockAlias={() => blockAlias(group)}
                  />
                ))}
              </ul>
            </li>
          ))}
          {decided.map(({ group, verdict }) => (
            <ScreenerRow
              key={`decided-${rowKey(group)}`}
              group={group}
              selected={false}
              verdict={verdict}
              onSelect={() => {}}
              onView={() => {}}
              onApprove={() => {}}
              onDeny={() => {}}
              onBlock={() => {}}
              onBlockDomain={() => {}}
              onSpam={() => {}}
              onBlockAlias={() => {}}
            />
          ))}
        </ul>
      )}
      {/* The bay states its own rule at the foot: a Verdict is scoped to one
          Mail Account and decides a sender, not a message (CONTEXT.md). */}
      <p className="screener-rule">
        One decision per sender, not per message. Approving lets their mail through and loads their
        remote images; blocking sends future mail straight to Trash (Mark as spam moves it to Junk
        instead). Either way it applies to the sender's own Mail Account only.
      </p>
      <ScreenerViewDialog
        group={viewingGroup}
        onClose={() => setViewingKey(null)}
        onApprove={() => viewingGroup && decide("approveSender", viewingGroup)}
        onDeny={() => viewingGroup && decide("denySender", viewingGroup)}
        onBlock={() => viewingGroup && decide("blockSender", viewingGroup)}
        onBlockDomain={() => viewingGroup && blockDomain(viewingGroup)}
        onSpam={() => viewingGroup && decide("spamSender", viewingGroup)}
        onBlockAlias={() => viewingGroup && blockAlias(viewingGroup)}
      />
      <BlockAliasDialog
        group={confirmingAliasGroup}
        onConfirm={confirmBlockAlias}
        onClose={() => setConfirmingAliasKey(null)}
      />
    </section>
  );
}

/**
 * One stranger's slip: the correspondent's own tile (the same mark the Inbox
 * draws them with, so the Screener is recognisably the same product rather
 * than a second one), who they are, a peek at what they sent, View (#102),
 * and the Screener's decisions (`ScreenerActions.tsx`). Approve is the only
 * filled control on the screen — Return and Block stay quiet until reached
 * for, and Block answers in danger rather than sitting in it.
 */
function ScreenerRow({
  group,
  selected,
  verdict = null,
  onSelect,
  onView,
  onApprove,
  onDeny,
  onBlock,
  onBlockDomain,
  onSpam,
  onBlockAlias,
}: {
  group: ScreenerSenderGroup;
  selected: boolean;
  /** The Verdict just applied — the slip states it and then clears. */
  verdict?: string | null;
  onSelect: () => void;
  onView: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onBlock: () => void;
  onBlockDomain: () => void;
  onSpam: () => void;
  onBlockAlias: () => void;
}) {
  const displayName = group.name ?? group.address;
  const actions = useActions();
  // A decided slip is on its way out and carries no actions any more.
  const rowCtx =
    actions && !verdict
      ? withScreenerSender(actions, { sender: group, onApprove, onDeny, onBlock })
      : null;
  return (
    <ActionMenu ctx={rowCtx} asChild label={`Actions for ${displayName}`}>
      <li
        className={`screener-row${selected ? " selected" : ""}${verdict ? " decided" : ""}`}
        aria-hidden={verdict ? true : undefined}
        onMouseEnter={verdict ? undefined : onSelect}
        aria-label={displayName}
      >
        <Avatar name={displayName} />
        <div className="screener-row-sender">
          <span className="screener-row-name">{displayName}</span>
          {group.name ? <span className="screener-row-address">{group.address}</span> : null}
          {group.threadCount > 1 ? (
            <span className="screener-row-count">{group.threadCount} conversations</span>
          ) : null}
        </div>
        {verdict ? null : (
          <div className="screener-row-peek">
            <span className="screener-row-subject">{group.subject || "(no subject)"}</span>
            {group.snippet ? <span className="screener-row-snippet">{group.snippet}</span> : null}
          </div>
        )}
        {verdict ? (
          <span className="screener-verdict" data-verdict={verdict}>
            {verdict}
          </span>
        ) : (
          <>
            <button type="button" className="screener-view" onClick={onView} title="View held mail">
              <Eye size={14} /> View
            </button>
            <ScreenerActions
              group={group}
              onApprove={onApprove}
              onDeny={onDeny}
              onBlock={onBlock}
              onBlockDomain={onBlockDomain}
              onSpam={onSpam}
              onBlockAlias={onBlockAlias}
            />
          </>
        )}
      </li>
    </ActionMenu>
  );
}
