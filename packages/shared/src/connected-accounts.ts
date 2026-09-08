import { z } from "zod";
import { providerSchema } from "./providers.js";

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
 * Which thing a Connected Account is turned on for (#199, ADR-0022,
 * CONTEXT.md's Facet). `mail` is the one every Connected Account created by
 * today's add-a-Mail-Account flows already carries; `calendar`/`contacts`
 * are Calendar and Contacts' own doors (#201+), not yet reachable from this
 * app but already real values a Connected Account's `facets` can hold.
 */
export const connectedAccountFacetKindSchema = z.enum(["mail", "calendar", "contacts"]);
export type ConnectedAccountFacetKind = z.infer<typeof connectedAccountFacetKindSchema>;

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
