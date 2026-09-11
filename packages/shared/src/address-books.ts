import { z } from "zod";
import { originSchema } from "./origin.js";

/**
 * `AddressBook` (#209, ADR-0023, ADR-0026): a registry descriptor on both
 * sides, riding **two** Sync Scopes — the User slot for the Local Address
 * Book, each Connected Account's slot for a mirrored one
 * (`sync.ts#userSyncRequestSchema`/`connectedAccountSyncRequestSchema`).
 * Whole-replicated, the same "small collection" posture `Note`/
 * `ConnectedAccount` already have.
 *
 * The Contacts App and every upstream adapter are later tickets (#210+):
 * this is the wire shape and the Local Address Book alone.
 */

/**
 * Which Origin's field-capability table (`contacts.ts#ContactCapabilityTable`)
 * a Contact of this Address Book is drawn against — ADR-0026: "Each
 * Origin's adapter declares a field-capability table ... The Local Address
 * Book's table is the superset." A separate field from `origin` rather than
 * derived from it: a future CardDAV server-specific table could diverge
 * from `caldav_carddav`'s own generic one without reshaping `origin`, and
 * every book an adapter creates from one Connected Account shares its
 * Provider's single identifier here regardless of which Address Book. Kept
 * as its own literal list rather than imported from `providers.ts`'s
 * `Provider` — the same "two independent lists, kept in sync by hand"
 * convention `db/schema.ts`'s own `provider` column enum already follows —
 * because `"local"` is not a Provider.
 */
export const addressBookCapabilityTableIdSchema = z.enum([
  "local",
  "google",
  "microsoft",
  "caldav_carddav",
]);
export type AddressBookCapabilityTableId = z.infer<typeof addressBookCapabilityTableIdSchema>;

/**
 * `id` is a ULID (ADR-0026's own id scheme, extended here to the Address
 * Book that holds a Contact). `mirrored` (ADR-0031) is always `false` until
 * an upstream adapter exists (#214+) — the Local Address Book is never
 * mirrored, and no other kind exists yet. `isDefault` names the Default
 * Address Book (CONTEXT.md): the Local Address Book is the default until a
 * later ticket lets the User change it.
 */
export const addressBookSchema = z.object({
  id: z.string(),
  name: z.string(),
  origin: originSchema,
  mirrored: z.boolean(),
  isDefault: z.boolean(),
  capabilityTableId: addressBookCapabilityTableIdSchema,
  createdAt: z.iso.datetime(),
});
export type AddressBook = z.infer<typeof addressBookSchema>;

/** The Local Address Book's fixed name (ADR-0026: "created on first use, never deletable") — nothing renames it in v1. */
export const LOCAL_ADDRESS_BOOK_NAME = "My Contacts";

/** Google's mirrored Address Book's fixed name (#214) — Google's People API has exactly one contacts collection per account (`resourceName` is "Required ... Only `people/me` is valid"), so there is no upstream name to mirror instead. */
export const GOOGLE_ADDRESS_BOOK_NAME = "Google Contacts";

/**
 * What unmirroring an Address Book discards (#215's own acceptance line:
 * "Unmirroring discards that book's Contacts at once"). Only `contacts` is
 * populated today — every Contact field family lives on the same row
 * (#210's own deliverable), so there is nothing else to count yet.
 * Additive: a future field family living on its own table adds a field
 * here, not a reshape — the same posture the sibling Calendar epic's own
 * `calendarMirrorImpactSchema` already took.
 */
export const addressBookMirrorImpactSchema = z.object({
  contacts: z.number().int().nonnegative(),
});
export type AddressBookMirrorImpact = z.infer<typeof addressBookMirrorImpactSchema>;

/** `GET /address-books/:id/unmirror-impact` — the checklist's confirm dialog's counts, before anything is discarded. */
export const unmirrorAddressBookImpactResponseSchema = z.object({
  discarded: addressBookMirrorImpactSchema,
});
export type UnmirrorAddressBookImpactResponse = z.infer<
  typeof unmirrorAddressBookImpactResponseSchema
>;

/**
 * `POST /address-books/:id/unmirror` — not an Optimistic Action (#215's own
 * acceptance line: "not an Optimistic Action"), so unlike a queued
 * `UserMutationIntent` this is a plain request/response: the Address Book's
 * `mirrored` flip and its discarded counts land in the same response, and
 * the Client never predicts either ahead of the round trip.
 */
export const unmirrorAddressBookResponseSchema = z.object({
  addressBook: addressBookSchema,
  discarded: addressBookMirrorImpactSchema,
});
export type UnmirrorAddressBookResponse = z.infer<typeof unmirrorAddressBookResponseSchema>;

/** `POST /address-books/:id/mirror` — re-mirroring, the checklist's other direction. */
export const mirrorAddressBookResponseSchema = z.object({ addressBook: addressBookSchema });
export type MirrorAddressBookResponse = z.infer<typeof mirrorAddressBookResponseSchema>;
