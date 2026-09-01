import { z } from "zod";
import { mailAccountSchema } from "./mail-accounts.js";

/**
 * The one delta endpoint (ADR-0011): `POST /sync` carries a map of
 * `{collection → stateToken}`, scoped per Mail Account plus a set of
 * User-scoped collections, and answers with per-collection
 * `{created, updated, destroyed, newState, hasMore}`. Only `MailAccount`
 * (User-scoped) and `Thread` (per Mail Account) are wired so far — the
 * envelope below is additive-only, so `Label`/`Preference`/`Draft`/etc. land
 * in their own tickets as new optional fields on the same request/response
 * shapes, never a reshape of them.
 *
 * A `stateToken` is opaque to the Client — it round-trips whatever this
 * package hands back and is never constructed or inspected client-side.
 */

/** One `From`/`To` participant, as it appears on a Thread's `participants`. */
export const threadParticipantSchema = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type ThreadParticipant = z.infer<typeof threadParticipantSchema>;

/**
 * The wire projection of a Thread (CONTEXT.md): the list-row summary, never
 * a Message body. Denormalized fields (`snippet`, `unreadCount`, ...) mirror
 * `sync/thread-rollup.ts`'s columns — this schema is that rollup's contract
 * with every Client.
 */
export const threadSchema = z.object({
  id: z.string(),
  mailAccountId: z.string(),
  subject: z.string(),
  participants: z.array(threadParticipantSchema),
  /** Null while the newest message's body is still behind the Index Watermark (#36). */
  snippet: z.string().nullable(),
  lastMessageId: z.string().nullable(),
  firstMessageAt: z.iso.datetime().nullable(),
  lastMessageAt: z.iso.datetime().nullable(),
  messageCount: z.int(),
  unreadCount: z.int(),
  starred: z.boolean(),
  hasAttachments: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type Thread = z.infer<typeof threadSchema>;

/**
 * One collection's delta since the state token the Client sent.
 * `reset: true` (ADR-0011) replaces the merge-in-place contract: the Client
 * discards whatever it had for this collection and treats `created` as the
 * whole current page instead of an addition to it. It is set on every page
 * of a reset's replay, not just the first, so a Client keeps replacing
 * (rather than merging) until `hasMore` finally goes false. Absent (never
 * `false`) the rest of the time.
 */
function collectionDeltaSchema<Payload extends z.ZodTypeAny>(payload: Payload) {
  return z.object({
    created: z.array(payload),
    updated: z.array(payload),
    /** Entity ids no longer in the collection — `sync/tombstones.ts`'s only readers. */
    destroyed: z.array(z.string()),
    newState: z.string(),
    hasMore: z.boolean(),
    reset: z.literal(true).optional(),
  });
}
export type CollectionDelta<Payload> = {
  created: Payload[];
  updated: Payload[];
  destroyed: string[];
  newState: string;
  hasMore: boolean;
  reset?: true;
};

export const mailAccountDeltaSchema = collectionDeltaSchema(mailAccountSchema);
export type MailAccountDelta = z.infer<typeof mailAccountDeltaSchema>;

export const threadDeltaSchema = collectionDeltaSchema(threadSchema);
export type ThreadDelta = z.infer<typeof threadDeltaSchema>;

/**
 * A requested collection's token. `null` asks for a full bootstrap (the
 * Client holds nothing yet — not the same as a stale/unrecognized token,
 * which the server can also answer with `reset: true`); omitting the key
 * entirely means "I'm not asking about this collection at all".
 */
const requestedTokenSchema = z.string().nullable();

export const userSyncRequestSchema = z.object({
  MailAccount: requestedTokenSchema.optional(),
});
export type UserSyncRequest = z.infer<typeof userSyncRequestSchema>;

export const mailAccountSyncRequestSchema = z.object({
  Thread: requestedTokenSchema.optional(),
});
export type MailAccountSyncRequest = z.infer<typeof mailAccountSyncRequestSchema>;

export const syncRequestSchema = z.object({
  /** User-scoped collections. */
  user: userSyncRequestSchema.optional(),
  /** Per-Mail-Account collections, keyed by Mail Account id. */
  mailAccounts: z.record(z.string(), mailAccountSyncRequestSchema).optional(),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/**
 * Mirrors the request, one level per scope. A collection is present in the
 * response only when something actually changed for it since the token the
 * Client sent — "unchanged collections return no payload" (#37) — so an
 * all-quiet poll answers with `{ user: {}, mailAccounts: {} }`.
 */
export const userSyncResponseSchema = z.object({
  MailAccount: mailAccountDeltaSchema.optional(),
});
export type UserSyncResponse = z.infer<typeof userSyncResponseSchema>;

export const mailAccountSyncResponseSchema = z.object({
  Thread: threadDeltaSchema.optional(),
});
export type MailAccountSyncResponse = z.infer<typeof mailAccountSyncResponseSchema>;

export const syncResponseSchema = z.object({
  user: userSyncResponseSchema,
  mailAccounts: z.record(z.string(), mailAccountSyncResponseSchema),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;
