import type { AddressBookCapabilityTableId } from "@mail/shared";

/**
 * The Origin badge's own display label (#211's acceptance line: "the Origin
 * badge sitting on the banner") — keyed on `capabilityTableId` rather than
 * `origin.kind` alone, since every mirrored Origin shares `kind:
 * "connectedAccount"` and needs its own upstream name on the badge (a
 * Google-mirrored card reads "Google", not merely "Connected"). `local` is
 * the one Origin every User has from the first sync round; the rest await
 * their own adapter (#226/#227) the same way `CONTACT_CAPABILITY_TABLES`
 * does.
 */
const ADDRESS_BOOK_ORIGIN_LABELS: Record<AddressBookCapabilityTableId, string> = {
  local: "Local",
  google: "Google",
  microsoft: "Microsoft",
  caldav_carddav: "CardDAV",
};

export function addressBookOriginLabel(capabilityTableId: AddressBookCapabilityTableId): string {
  return ADDRESS_BOOK_ORIGIN_LABELS[capabilityTableId];
}
