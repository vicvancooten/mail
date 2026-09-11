import {
  type MirrorAddressBookResponse,
  mirrorAddressBookResponseSchema,
  type UnmirrorAddressBookImpactResponse,
  type UnmirrorAddressBookResponse,
  unmirrorAddressBookImpactResponseSchema,
  unmirrorAddressBookResponseSchema,
} from "@mail/shared";
import { getJson, postJson } from "./auth.js";

/** The checklist's confirm dialog's counts, fetched before the User commits (#215: "confirmed with counts"). */
export function fetchUnmirrorAddressBookImpact(
  addressBookId: string,
): Promise<UnmirrorAddressBookImpactResponse> {
  return getJson(`/address-books/${addressBookId}/unmirror-impact`, (data) =>
    unmirrorAddressBookImpactResponseSchema.parse(data),
  );
}

/** Immediate, no Undo (#215's own acceptance line) — never queued as an Optimistic Action. */
export function unmirrorAddressBook(addressBookId: string): Promise<UnmirrorAddressBookResponse> {
  return postJson(`/address-books/${addressBookId}/unmirror`, {}, (data) =>
    unmirrorAddressBookResponseSchema.parse(data),
  );
}

export function mirrorAddressBook(addressBookId: string): Promise<MirrorAddressBookResponse> {
  return postJson(`/address-books/${addressBookId}/mirror`, {}, (data) =>
    mirrorAddressBookResponseSchema.parse(data),
  );
}
