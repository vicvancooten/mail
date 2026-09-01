import { z } from "zod";
import { composeSaveOutcomeSchema, composeSaveSchema, compositionSchema } from "./compose.js";
import { mailAccountSchema } from "./mail-accounts.js";

/**
 * The one delta endpoint (ADR-0011): `POST /sync` carries a map of
 * `{collection → stateToken}`, scoped per Mail Account plus a set of
 * User-scoped collections, and answers with per-collection
 * `{created, updated, destroyed, newState, hasMore}`. `MailAccount` is
 * User-scoped; `Thread`, `Label` and `Composition` are per Mail Account —
 * the envelope below is additive-only, so `Preference`/etc. land in their
 * own tickets as new optional fields on the same request/response shapes,
 * never a reshape of them.
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
  /**
   * Whether this Thread currently has a Message sitting in the Inbox
   * (#42). Not a general Folder projection — the Client still holds exactly
   * one list per Mail Account (`db.ts`) — just the one signal triage needs:
   * archiving/trashing flips it to `false` server-side (`sync/mutations.ts`)
   * so the Thread drops out of that list for good, on every Client, once
   * the intent lands, and not only for the duration of the Client's own
   * pending overlay.
   */
  inInbox: z.boolean(),
  /**
   * Whether this Thread is Pinned (#43): an App Feature, deliberately
   * distinct from `starred` (CONTEXT.md — a Star says "this matters", a Pin
   * says "keep this in front of me"). The Client sorts Pinned Threads to the
   * top of every view mode regardless of their date.
   */
  pinned: z.boolean(),
  /**
   * The Labels currently applied to this Thread, as `Label.id`s (#43). An
   * App Feature, denormalized here the same way `starred` is — the
   * `Label` collection below carries the id→name mapping, this is the
   * per-Thread membership, kept on the Thread row (rather than requiring a
   * join client-side) because every view already renders off one Thread
   * projection.
   */
  labelIds: z.array(z.string()),
  updatedAt: z.iso.datetime(),
});
export type Thread = z.infer<typeof threadSchema>;

/**
 * A Label (#43, CONTEXT.md): a User-defined tag, App Feature, no colors or
 * nesting at PoC scope. `id` is deterministic (`labelId` in
 * `packages/shared/src/labels.ts`) rather than server-minted, so applying a
 * brand-new Label is a single Optimistic Action with no id round trip first.
 */
export const labelSchema = z.object({
  id: z.string(),
  mailAccountId: z.string(),
  name: z.string(),
  updatedAt: z.iso.datetime(),
});
export type Label = z.infer<typeof labelSchema>;

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

export const labelDeltaSchema = collectionDeltaSchema(labelSchema);
export type LabelDelta = z.infer<typeof labelDeltaSchema>;

/**
 * `Composition` (#46, ADR-0007): Drafts and Pending Sends, per Mail Account.
 * The collection exists so a Pending Send's countdown is "visible and
 * cancellable from every device the User has open" — see
 * `compose.ts#compositionSchema` for why the whole document rides it rather
 * than the send state alone.
 */
export const compositionDeltaSchema = collectionDeltaSchema(compositionSchema);
export type CompositionDelta = z.infer<typeof compositionDeltaSchema>;

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

/**
 * A semantic Optimistic Action (ADR-0010, #39) — never a wire-level
 * operation, so a protocol change never invalidates a queued action still
 * sitting in a Client's Local Cache. Additive: a future `pin`/`label`
 * intent is a new union member, never a reshape of these four.
 *
 * `setStarred`/`setRead` apply to *every* Message in the Thread — the same
 * "whole Thread" granularity `sync/thread-rollup.ts` already aggregates
 * over, so the optimistic overlay's predicted `unreadCount`/`starred`
 * matches exactly what the backend will compute once the intent lands.
 *
 * `archive`/`trash` (#42) are one-directional — there is no `unarchive`
 * intent yet, so unlike the two above they never coalesce with anything in
 * `store/mutation-queue.ts`. Applying one flips the Thread's `inInbox` to
 * `false` and, asynchronously, moves whatever of its Messages sit in the
 * Inbox to the account's Archive/Trash folder over real IMAP (ADR-0006).
 *
 * `setPinned` (#43) mirrors `setStarred`'s absolute-set shape exactly, but
 * — Pin being an App Feature (ADR-0006) — never enqueues a protocol write:
 * it touches only the Thread row, never a Message's flags.
 *
 * `applyLabel`/`removeLabel` (#43) carry the Label's `name`, not its id: the
 * id is deterministic (`labelId` in `packages/shared/src/labels.ts`) from
 * `(mailAccountId, name)`, so both the Client's optimistic overlay
 * (`store/reads.ts`) and the Sync Backend derive the same id independently
 * rather than one minting it and handing it to the other. Applying a name
 * with no existing Label creates one; removing a name with no effect is a
 * harmless no-op, the same tolerance `archive`/`trash` already have for a
 * Thread that's already in the state being asked for.
 *
 * `sendComposition`/`cancelSend` (#46) are the first intents that name a
 * Composition rather than a Thread. They ride this queue rather than a
 * dedicated route because ADR-0014 says so directly — "an offline send
 * queues, and says so ... it becomes a Pending Send intent, and the Undo
 * Send countdown starts only when the Sync Backend accepts it" — which is
 * exactly the durable, offline-survivable, idempotent-by-id delivery the
 * queue already provides. Neither carries a delay: `submit_after` is the
 * server's to compute from the User's own preference, because ADR-0007
 * measures the delay "from server receipt, never from the Client's clock".
 * `cancelSend` is the one intent whose rejection is a *normal* outcome the
 * User must be told about: a cancel that arrives after
 * `compose/pending-send.ts`'s atomic claim is rejected `too_late`
 * (ADR-0007: "a cancel arriving after the claim loses and is reported to
 * the User as too late").
 */
export const mutationIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setStarred"), threadId: z.string(), starred: z.boolean() }),
  z.object({ type: z.literal("setRead"), threadId: z.string(), read: z.boolean() }),
  z.object({ type: z.literal("archive"), threadId: z.string() }),
  z.object({ type: z.literal("trash"), threadId: z.string() }),
  z.object({ type: z.literal("setPinned"), threadId: z.string(), pinned: z.boolean() }),
  z.object({ type: z.literal("applyLabel"), threadId: z.string(), name: z.string() }),
  z.object({ type: z.literal("removeLabel"), threadId: z.string(), name: z.string() }),
  z.object({ type: z.literal("sendComposition"), compositionId: z.string() }),
  z.object({ type: z.literal("cancelSend"), compositionId: z.string() }),
]);
export type MutationIntent = z.infer<typeof mutationIntentSchema>;

/**
 * One queued Optimistic Action as it rides the wire: `id` is the
 * Client-generated ULID idempotency key (ADR-0010), echoed back verbatim in
 * the matching `MutationOutcome`. A Mail Account's array is sent, and must
 * be applied, in **strict FIFO order** — the array's order *is* the queue's
 * order, never re-derived from a timestamp on the server side.
 */
export const queuedMutationSchema = z.object({
  id: z.string(),
  intent: mutationIntentSchema,
});
export type QueuedMutation = z.infer<typeof queuedMutationSchema>;

/**
 * One mutation's outcome (ADR-0011's third divergence: a mutation-flush
 * response carries deltas back in the same round trip). `applied` covers
 * both "just applied" and "already applied — this id was a retry", so the
 * Client always dequeues on it; `rejected` is permanent and is never
 * retried by the Client (a transient failure never reaches this shape at
 * all — it fails the whole `POST /sync` instead, per the ordinary
 * network-error/backoff path).
 */
export const mutationOutcomeSchema = z.object({
  id: z.string(),
  status: z.enum(["applied", "rejected"]),
  reason: z.string().optional(),
});
export type MutationOutcome = z.infer<typeof mutationOutcomeSchema>;

export const mailAccountSyncRequestSchema = z.object({
  Thread: requestedTokenSchema.optional(),
  Label: requestedTokenSchema.optional(),
  Composition: requestedTokenSchema.optional(),
  /** This account's queue to flush, oldest first. Omitted (never `[]`) when there is nothing queued for it. */
  mutations: z.array(queuedMutationSchema).optional(),
  /**
   * Composition autosaves to flush (ADR-0014, `compose.ts`) — a *separate*
   * array from `mutations` above, not a `MutationIntent` variant, because it
   * coalesces (last-write-wins per Composition) rather than draining FIFO.
   * At most one entry per Composition per round: `store/compositions.ts`'s
   * coalescing queue holds only the latest save.
   */
  composeSaves: z.array(composeSaveSchema).optional(),
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
 * all-quiet poll answers with `{ user: {}, mailAccounts: {} }`. `mutations`
 * follows the same rule but on a different trigger: present whenever the
 * request carried mutations to flush for that account, regardless of
 * whether the Thread delta itself is non-empty (an idempotent replay can
 * report `applied` with no further Thread change at all).
 */
export const userSyncResponseSchema = z.object({
  MailAccount: mailAccountDeltaSchema.optional(),
});
export type UserSyncResponse = z.infer<typeof userSyncResponseSchema>;

export const mailAccountSyncResponseSchema = z.object({
  Thread: threadDeltaSchema.optional(),
  Label: labelDeltaSchema.optional(),
  Composition: compositionDeltaSchema.optional(),
  /** Outcomes in the same order as the request's `mutations` array. */
  mutations: z.array(mutationOutcomeSchema).optional(),
  /** Outcomes in the same order as the request's `composeSaves` array. */
  composeSaves: z.array(composeSaveOutcomeSchema).optional(),
});
export type MailAccountSyncResponse = z.infer<typeof mailAccountSyncResponseSchema>;

export const syncResponseSchema = z.object({
  user: userSyncResponseSchema,
  mailAccounts: z.record(z.string(), mailAccountSyncResponseSchema),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;
