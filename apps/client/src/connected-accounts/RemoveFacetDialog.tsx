import type {
  ConnectedAccount,
  ConnectedAccountFacetKind,
  ConnectedAccountFacetRemovalPreview,
} from "@mail/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchConnectedAccountFacetRemovalPreview,
  PendingSendBlocksRemovalError,
  removeConnectedAccountFacet,
} from "../api/connected-accounts.js";
import { requestSyncNow } from "../sync/sync-loop.js";
import { FACET_LABEL, PROVIDER_TABLE_LABEL } from "./provider-table.js";

/**
 * Google revokes its own Grant server-side on whole-account removal
 * (best-effort, `routes/connected-accounts.ts`); Microsoft's identity
 * platform has no equivalent a confidential client can call on the User's
 * behalf, so a Member removing a Microsoft account is pointed at their own
 * account page instead (#206, ADR-0029: "Microsoft Users get a link to
 * their account page").
 */
const MICROSOFT_ACCOUNT_URL = "https://account.live.com/consent/Manage";

/**
 * The confirmed-act dialog turning off a Facet or removing a Connected
 * Account opens (#206, ADR-0029: "a confirmed, immediate, online act with
 * no Undo"). Fetches a fresh preview every time it opens rather than
 * trusting anything the Popover already knew — the Thread count and
 * whether a Pending Send blocks removal can both have changed since the
 * table last rendered.
 *
 * The actual block is enforced server-side, at confirm time, against the
 * request's own clock (`removeConnectedAccountFacet` throwing
 * `PendingSendBlocksRemovalError`) — the preview's own
 * `pendingSendBlockSeconds` is shown only as a heads-up, never disables the
 * confirm button, so a User who opens the dialog just as the window closes
 * isn't stuck looking at a stale countdown.
 */
export function RemoveFacetDialog({
  account,
  facet,
  open,
  onOpenChange,
}: {
  account: ConnectedAccount;
  facet: ConnectedAccountFacetKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [preview, setPreview] = useState<ConnectedAccountFacetRemovalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setError(null);
      setRemoving(false);
      return;
    }
    let cancelled = false;
    fetchConnectedAccountFacetRemovalPreview(account.id, facet)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't check what this removes — try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, account.id, facet]);

  async function handleConfirm() {
    setError(null);
    setRemoving(true);
    try {
      await removeConnectedAccountFacet(account.id, facet);
      // This device's own Local Cache learns the same way every other
      // device does — the ConnectedAccount/MailAccount collections' next
      // delta (`removal.ts`'s own doc comment) — `requestSyncNow` just
      // pulls that round in immediately rather than waiting on the poll.
      requestSyncNow();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof PendingSendBlocksRemovalError) {
        setError(
          `A message is still inside its Undo Send window — wait ${err.secondsRemaining}s, or let it finish sending, before removing this.`,
        );
      } else {
        setError("Couldn't remove this — try again.");
      }
      setRemoving(false);
    }
  }

  const providerLabel = PROVIDER_TABLE_LABEL[account.provider];
  const facetLabel = FACET_LABEL[facet];
  // Falls back to the Popover's own facet count while the preview is still
  // loading, so the title never flashes the wrong wording once it lands.
  const accountRemoved = preview?.accountRemoved ?? account.facets.length === 1;

  return (
    <Dialog open={open} onOpenChange={(next) => !removing && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {accountRemoved
              ? `Remove the ${providerLabel} account?`
              : `Turn off ${facetLabel.toLowerCase()}?`}
          </DialogTitle>
          <DialogDescription>
            {facet === "mail"
              ? preview
                ? `This discards ${preview.threadCount.toLocaleString()} synced threads. This can't be undone.`
                : "Checking what this removes…"
              : "Nothing is synced for this yet — turning it off just disconnects it. This can't be undone."}
          </DialogDescription>
        </DialogHeader>

        {preview?.pendingSendBlockSeconds != null && (
          <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
            A message is still inside its Undo Send window (~{preview.pendingSendBlockSeconds}s
            left) — removing now will wait for it, or you can let it send first.
          </p>
        )}

        {accountRemoved && (
          <p className="text-sm text-muted-foreground">
            This also removes the {providerLabel} account and its stored credential. Adding it again
            later starts from scratch.
            {account.provider === "microsoft" && (
              <>
                {" "}
                You can also{" "}
                <a href={MICROSOFT_ACCOUNT_URL} target="_blank" rel="noreferrer">
                  remove this app's access from your Microsoft account
                </a>
                .
              </>
            )}
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={removing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void handleConfirm()}
            disabled={removing || !preview}
          >
            {accountRemoved ? "Remove account" : "Turn off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
