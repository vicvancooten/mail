import { isBarredVerdictDomain, senderDomain } from "@mail/shared";
import { Ban, Check, ChevronDown, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import type { ScreenerSenderGroup } from "../../store/index.js";

/**
 * The Screener's three decisions (#56) plus #102's Block split menu, shared
 * between a row's own slip and the View dialog's "decision actions on top"
 * (the ticket's own words) — one component so the two surfaces can never
 * drift apart on what a decision does or how it reads.
 *
 * Block is a `DropdownMenu` (full shadcn, no hand-rolled popover) rather than
 * three flat buttons: *Block sender* stays the one-click default — the split
 * button's own face — while *Block domain* and *Mark as spam* sit behind the
 * chevron as the deliberate extra click #102's grill decision asks for
 * (CONTEXT.md's Spam: "the two claims ... are different, and only the User
 * can tell them apart"). Deny stays its own plain button beside them — it is
 * not a Verdict (the ticket's own words), so it never joins Block's menu.
 */
export function ScreenerActions({
  group,
  onApprove,
  onDeny,
  onBlock,
  onBlockDomain,
  onSpam,
}: {
  group: ScreenerSenderGroup;
  onApprove: () => void;
  onDeny: () => void;
  onBlock: () => void;
  onBlockDomain: () => void;
  onSpam: () => void;
}) {
  const domain = senderDomain(group.address);
  // The barred-public-provider refusal (ADR-0008, `gatekeeper.ts`'s
  // `BARRED_VERDICT_DOMAINS`), kept client-side too: offering a button whose
  // only possible answer is a rejection is worse than not offering it, and
  // the Sync Backend still refuses it either way if a stale Client somehow
  // sends it anyway (`RollbackToast.tsx`'s `spamSender`/`blockSender` cases).
  const domainBlockable = domain !== null && !isBarredVerdictDomain(domain);

  return (
    <div className="screener-row-actions">
      <button type="button" className="screener-approve" onClick={onApprove} title="Approve (a)">
        <Check size={14} /> Approve
      </button>
      <button type="button" className="screener-deny" onClick={onDeny} title="Deny (d)">
        <X size={14} /> Deny
      </button>
      <div className="screener-block-split">
        <button type="button" className="screener-block" onClick={onBlock} title="Block (b)">
          <Ban size={14} /> Block
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="screener-block-menu-trigger"
              aria-label={`More block options for ${group.name ?? group.address}`}
            >
              <ChevronDown size={12} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              disabled={!domainBlockable}
              onSelect={onBlockDomain}
            >
              {domainBlockable
                ? `Block domain (${domain})`
                : domain
                  ? `Block domain — not offered for ${domain}`
                  : "Block domain"}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onSpam}>
              Mark as spam
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
