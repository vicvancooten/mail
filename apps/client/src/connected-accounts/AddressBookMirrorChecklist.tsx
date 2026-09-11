import type { AddressBook } from "@mail/shared";
import { useState } from "react";
import {
  fetchUnmirrorAddressBookImpact,
  mirrorAddressBook,
  unmirrorAddressBook,
} from "@/api/address-books.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAddressBooksForConnectedAccount } from "@/store/address-books.js";

/**
 * The Contacts Facet cell's own selective-sync checklist (#215, the
 * #172-prototype-locked home for it: "the checklist lives in the Contacts
 * Facet cell's Popover on the Connected Accounts page") — mounted inside
 * `ConnectedAccountFacetBadge.tsx`'s own Popover content for `facet ===
 * "contacts"`.
 *
 * Every discovered Address Book gets a row here whether mirrored or not
 * (this ticket's own acceptance line) — `useAddressBooksForConnectedAccount`
 * reads straight off the Local Cache's `AddressBook` collection, which the
 * Google People sync loop already rows on every 15-minute tick
 * (`address-books/store.ts#ensureGoogleAddressBook`, called unconditionally
 * from `people-sync.ts` regardless of whether the book is mirrored).
 *
 * Checking a box back on is a plain, harmless `mirrorAddressBook` call.
 * Unchecking one is never optimistic (this ticket's own acceptance line:
 * "not an Optimistic Action") — it opens `unmirror-impact`'s counts in a
 * confirm Dialog first, and the row's own checked state only ever reflects
 * what the Local Cache actually holds, never a local prediction; the
 * `pendingId` state below only disables the row mid-request so a second
 * click can't race the first.
 */
export function AddressBookMirrorChecklist({ connectedAccountId }: { connectedAccountId: string }) {
  const addressBooks = useAddressBooksForConnectedAccount(connectedAccountId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<AddressBook | null>(null);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck(addressBook: AddressBook) {
    setError(null);
    setPendingId(addressBook.id);
    try {
      await mirrorAddressBook(addressBook.id);
    } catch {
      setError(`Couldn't mirror "${addressBook.name}" — try again.`);
    } finally {
      setPendingId(null);
    }
  }

  async function handleUncheck(addressBook: AddressBook) {
    setError(null);
    try {
      const { discarded } = await fetchUnmirrorAddressBookImpact(addressBook.id);
      setConfirmTarget(addressBook);
      setConfirmCount(discarded.contacts);
    } catch {
      setError(`Couldn't check "${addressBook.name}"'s sync status — try again.`);
    }
  }

  async function confirmUnmirror() {
    if (!confirmTarget) return;
    const addressBook = confirmTarget;
    setPendingId(addressBook.id);
    setConfirmTarget(null);
    setConfirmCount(null);
    try {
      await unmirrorAddressBook(addressBook.id);
    } catch {
      setError(`Couldn't stop mirroring "${addressBook.name}" — try again.`);
    } finally {
      setPendingId(null);
    }
  }

  if (addressBooks === undefined) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {addressBooks.length === 0 && (
        <p className="text-sm text-muted-foreground">No address books found on this account.</p>
      )}
      {addressBooks.map((addressBook) => (
        <label
          key={addressBook.id}
          className="flex items-center gap-2 text-sm"
          htmlFor={`mirror-${addressBook.id}`}
        >
          <input
            id={`mirror-${addressBook.id}`}
            type="checkbox"
            checked={addressBook.mirrored}
            disabled={pendingId === addressBook.id}
            onChange={(event) => {
              if (event.target.checked) void handleCheck(addressBook);
              else void handleUncheck(addressBook);
            }}
          />
          {addressBook.name}
        </label>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmTarget(null);
            setConfirmCount(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop mirroring "{confirmTarget?.name}"?</DialogTitle>
            <DialogDescription>
              {confirmCount === 0
                ? "This address book has no contacts synced yet."
                : `This discards ${confirmCount} synced ${confirmCount === 1 ? "contact" : "contacts"} immediately. This can't be undone — the address book itself stays here and can be re-mirrored later.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmUnmirror()}>
              Stop mirroring
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
