import { z } from "zod";
import {
  type ConnectedAccountFacetKind,
  connectedAccountFacetKindSchema,
  providerSchema,
} from "./providers.js";

export type { ConnectedAccountFacetKind };
export { connectedAccountFacetKindSchema };

/**
 * `active` syncs normally. `needs_reauth` (ADR-0022, CONTEXT.md) is what a
 * rejected credential or a withdrawn Grant parks a Connected Account (or one
 * of its Facets) in — mirrors `mail-accounts.ts#mailAccountStatusSchema`,
 * kept as its own schema rather than reused across both: a Mail Account's
 * `status` is *projected* from its Mail Facet's own row
 * (`toWireMailAccount`'s doc comment), two different collections that only
 * happen to share the same two values today.
 */
export const connectedAccountStatusSchema = z.enum(["active", "needs_reauth"]);
export type ConnectedAccountStatus = z.infer<typeof connectedAccountStatusSchema>;

/**
 * One Facet's wire projection (#200): just enough for a label or a Needs
 * Reauth badge to render per-Facet — never `scopesLastGrantedAt` or the
 * CalDAV/CardDAV discovery columns (`db/schema.ts#connectedAccountFacets`),
 * which are this instance's own bookkeeping, not something any Client
 * surface reads today.
 */
export const connectedAccountFacetSchema = z.object({
  kind: connectedAccountFacetKindSchema,
  status: connectedAccountStatusSchema,
});
export type ConnectedAccountFacet = z.infer<typeof connectedAccountFacetSchema>;

/**
 * `ConnectedAccount` (#199, #200, ADR-0022): the User-scoped, whole-replicated
 * collection every "which account is this" label, the Settings table and the
 * Account Scope picker render from offline. Deliberately **no credential
 * field, not even a masked one** — ADR-0003's write-only rule, the same line
 * `mail-accounts.ts#mailAccountSchema`'s own doc comment draws. `provider`
 * is the glossary's full four-value `Provider` (`providers.ts`), unlike
 * `MailAccount.authKind`'s narrower `RegisteredProvider` — Other IMAP and
 * CalDAV/CardDAV are real Providers a Connected Account can be at, just
 * never an OAuth `authKind`. `identity` is the signed-in address or entered
 * username that makes this row unique per User and Provider
 * (`db/schema.ts#connectedAccounts`'s own doc comment). `facets` is the
 * account's full Facet register, embedded rather than a collection of its
 * own — a handful of rows per account, always read together with the
 * account itself.
 */
export const connectedAccountSchema = z.object({
  id: z.string(),
  userId: z.string(),
  provider: providerSchema,
  identity: z.string(),
  status: connectedAccountStatusSchema,
  facets: z.array(connectedAccountFacetSchema),
  createdAt: z.iso.datetime(),
});
export type ConnectedAccount = z.infer<typeof connectedAccountSchema>;

/**
 * The two Facets CalDAV/CardDAV discovery (#203) ever runs for — never
 * `mail`, which no CalDAV/CardDAV account carries (`provider-table.ts`'s own
 * `FACET_SUPPORTED_BY_PROVIDER`).
 */
export const davFacetSchema = z.enum(["calendar", "contacts"]);
export type DavFacet = z.infer<typeof davFacetSchema>;

/**
 * The three failures #203's acceptance criteria names distinctly, each its
 * own plain message rather than one generic "couldn't add this account":
 * `unreachable` — none of discovery's candidate hosts answered at all;
 * `credentials_rejected` — a host answered but refused the username/app
 * password; `no_home_set` — a host authenticated fine but has no
 * calendar/address-book home for this Facet.
 */
export const davDiscoveryFailureReasonSchema = z.enum([
  "unreachable",
  "credentials_rejected",
  "no_home_set",
]);
export type DavDiscoveryFailureReason = z.infer<typeof davDiscoveryFailureReasonSchema>;

/**
 * `POST /connected-accounts/caldav` (#203): a brand-new CalDAV/CardDAV
 * identity — server or email address, username and app password — plus
 * which Facet to run discovery for first. Refused (409) when this User
 * already has a Connected Account at this `username`
 * (`connected_accounts_user_provider_identity_key`) — turning on a second
 * Facet on that account is `POST /connected-accounts/:id/caldav-facets`
 * below, which never asks for the password again.
 */
export const createCalDavAccountRequestSchema = z.object({
  serverAddress: z.string().trim().min(1, "Server or email address is required"),
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "App password is required"),
  facet: davFacetSchema,
});
export type CreateCalDavAccountRequest = z.infer<typeof createCalDavAccountRequestSchema>;

/**
 * `POST /connected-accounts/:id/caldav-facets` (#203): turning on the second
 * Facet on an already-connected CalDAV/CardDAV account — discovery only,
 * against the credential already sealed on that Connected Account.
 */
export const addCalDavFacetRequestSchema = z.object({
  facet: davFacetSchema,
});
export type AddCalDavFacetRequest = z.infer<typeof addCalDavFacetRequestSchema>;

/**
 * What discovery found, reported back rather than offered as a mirror
 * checklist (#203's own scope note, ADR-0031 and the Calendar/Contacts
 * epics own "choosing what to mirror") — a count and the discovered
 * collections' own display names, e.g. "3 calendars, 1 address book".
 */
export const davDiscoverySummarySchema = z.object({
  count: z.int().nonnegative(),
  names: z.array(z.string()),
});
export type DavDiscoverySummary = z.infer<typeof davDiscoverySummarySchema>;

/** Both CalDAV routes' success shape: the discovery feedback the Popover renders. */
export const calDavFacetResponseSchema = z.object({
  connectedAccountId: z.string(),
  facet: davFacetSchema,
  discovered: davDiscoverySummarySchema,
  /** RFC 6638 scheduling — only ever true for `facet: "calendar"` (CardDAV has no scheduling concept). */
  supportsScheduling: z.boolean(),
});
export type CalDavFacetResponse = z.infer<typeof calDavFacetResponseSchema>;

/**
 * `GET /connected-accounts/:id/facets/:kind/removal-preview` (#206,
 * ADR-0029: "the confirmation names what goes in counts"). `threadCount` is
 * `0` for a Facet with no mirror yet — Calendar and Contacts collections
 * don't exist in this app yet (#198's own scope note), so today only the
 * Mail Facet ever carries a real count. `accountRemoved` names the "last
 * Facet takes the account with it" branch ahead of the confirm click, so the
 * dialog can word itself as a Facet turn-off or a whole-account removal
 * before the User commits to either. `pendingSendBlockSeconds` is the Undo
 * Send window's remaining seconds when a still-cancellable Pending Send
 * would block removal right now — `null` when nothing blocks.
 */
export const connectedAccountFacetRemovalPreviewSchema = z.object({
  threadCount: z.number().int().nonnegative(),
  accountRemoved: z.boolean(),
  pendingSendBlockSeconds: z.number().int().positive().nullable(),
});
export type ConnectedAccountFacetRemovalPreview = z.infer<
  typeof connectedAccountFacetRemovalPreviewSchema
>;

/** `DELETE /connected-accounts/:id/facets/:kind`'s success answer (#206). */
export const removeConnectedAccountFacetResponseSchema = z.object({
  accountRemoved: z.boolean(),
});
export type RemoveConnectedAccountFacetResponse = z.infer<
  typeof removeConnectedAccountFacetResponseSchema
>;

/** `POST /connected-accounts/:id/reauth`'s success answer (#204) — the same "return the fresh row, the Client's own liveQuery already renders it" shape `mail-accounts.ts#mailAccountResponseSchema` uses for the Mail-scoped reauth route. */
export const connectedAccountResponseSchema = z.object({
  connectedAccount: connectedAccountSchema,
});
export type ConnectedAccountResponse = z.infer<typeof connectedAccountResponseSchema>;

/**
 * `POST /connected-accounts/:id/reauth` (#204): a CalDAV/CardDAV account's
 * own Needs Reauth Fix — never a username (CalDAV/CardDAV's identity *is*
 * its username, unchanged since the account was added,
 * `db/schema.ts#connectedAccounts`'s own doc comment), only a fresh app
 * password to re-verify by discovery. Account-level only (ADR-0022: "a
 * CalDAV/CardDAV 401 is always the account level, since both Facets share
 * the password") — there is no per-Facet CalDAV reauth.
 */
export const reauthConnectedAccountRequestSchema = z.object({
  password: z.string().min(1, "App password is required"),
});
export type ReauthConnectedAccountRequest = z.infer<typeof reauthConnectedAccountRequestSchema>;
