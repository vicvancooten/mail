import { z } from "zod";

/**
 * The Bulk Triage batch endpoints (#67, part of #66's Group bulk Triage):
 * **Done all** and **Mark all read** on a whole group of Threads in one
 * request. Deliberately outside ADR-0011's `POST /sync` — like `POST
 * /search`, this is a stateless action/query pair, not a synced collection —
 * and deliberately outside the Optimistic Action queue (`sync.ts`'s
 * `mutationIntentSchema`) too: those name one Thread each, and a group can
 * hold thousands the Client never loaded.
 *
 * The Client names the target set as **date range + folder + Account
 * Scope**, never a thread-id list — the whole point being that a group the
 * Client cannot enumerate (it was never loaded) is still clearable. The
 * server resolves that shape against its own Thread rows **at request
 * time**, which is what makes "a Thread arriving after the request is not
 * included" true by construction rather than by a race the Client has to
 * avoid.
 */

/** `done` mirrors the single-Thread `archive` intent's effect (`sync.ts`); `markRead` mirrors `setRead: true`'s. Batched, across a whole target set. */
export const bulkTriageActionSchema = z.enum(["done", "markRead"]);
export type BulkTriageAction = z.infer<typeof bulkTriageActionSchema>;

/**
 * Past this many affected Threads on one Mail Account, the batch bumps that
 * account's Thread rebuild epoch (`db/schema.ts`'s `threadsEpoch`) instead of
 * leaving thousands of rows for `POST /sync` to page through as ordinary
 * `updated` deltas — the next Thread sync for that account answers
 * `reset: true` and re-bootstraps, the same mechanism ADR-0011 already
 * defines for "the underlying state was rebuilt" (a UIDVALIDITY change, a
 * Reset Gatekeeper). Recorded as ADR-0011's bulk-Done amendment.
 */
export const BULK_TRIAGE_RESET_THRESHOLD = 200;

/** How long after a batch applies its identifier can still undo it (~10s toast, #66's Group bulk Triage). */
export const BULK_TRIAGE_UNDO_WINDOW_SECONDS = 10;

/**
 * The folder a batch targets, by role — the same vocabulary
 * `search.ts#searchResultFolderSchema` inlines for the same reason: a wire
 * enum of `sync-backend`'s `FolderRole`, duplicated rather than shared,
 * because the type only exists server-side (`sync/folders.ts`) and this
 * package never depends on that app.
 */
export const bulkTriageFolderRoleSchema = z.enum([
  "inbox",
  "archive",
  "drafts",
  "sent",
  "junk",
  "trash",
  "flagged",
  "all",
]);
export type BulkTriageFolderRole = z.infer<typeof bulkTriageFolderRoleSchema>;

/**
 * The target-set shape both the batch and the count query resolve
 * server-side: **date range + folder + Account Scope**. `since`/`until` bound
 * `Thread.lastMessageAt` — the same recency field the group ladder buckets
 * Threads by — and either may be `null` ("everything older" has no `since`;
 * "up to now" has no `until`).
 *
 * `until` is a ceiling the server is free to lower, never one the Client can
 * raise past "now" — see `bulk-triage.ts` (sync-backend) for where that
 * clamp actually happens. That clamp is the literal mechanism behind "a
 * Thread arriving after the request is not touched" (#67's acceptance bar):
 * evaluating the set against whatever `until` the Client sent would let a
 * generous or stale value reach past the request's own instant.
 */
export const bulkTriageTargetSchema = z
  .object({
    /** Mail Account ids in Account Scope. The User must own every one — an id they don't is reported `rejected` per-account, never silently dropped. */
    accountScope: z.array(z.string()).min(1),
    folderRole: bulkTriageFolderRoleSchema,
    /** Inclusive lower bound on `Thread.lastMessageAt`. `null` reaches every Thread down to the beginning ("Older", "everything older"). */
    since: z.iso.datetime().nullable(),
    /** Exclusive upper bound on `Thread.lastMessageAt`, clamped server-side to "now". `null` means "up to now" outright. */
    until: z.iso.datetime().nullable(),
  })
  .refine(
    (target) => target.since === null || target.until === null || target.since < target.until,
    {
      message: "since must be before until",
      path: ["since"],
    },
  );
export type BulkTriageTarget = z.infer<typeof bulkTriageTargetSchema>;

export const bulkTriageCountRequestSchema = bulkTriageTargetSchema;
export type BulkTriageCountRequest = BulkTriageTarget;

/** "How many Threads are in this group" — the same target-set shape, answered as a count instead of an action (#67: "a Client can show a group's true total rather than its loaded count"). */
export const bulkTriageCountResponseSchema = z.object({ count: z.int() });
export type BulkTriageCountResponse = z.infer<typeof bulkTriageCountResponseSchema>;

/**
 * One Mail Account's share of a batch (#67: "a batch spanning several Mail
 * Accounts reports per-account partial failure"). `rejected` covers both "the
 * User doesn't own this id" (`mail_account_not_found`) and "this account is
 * mid-reauth" (`needs_reauth`, ADR-0006's own Needs Reauth posture: queued
 * work holds rather than fails) — an account the batch skipped entirely, so
 * `affectedCount` is always `0` alongside it.
 */
export const bulkTriageAccountOutcomeSchema = z.object({
  mailAccountId: z.string(),
  status: z.enum(["applied", "rejected"]),
  affectedCount: z.int(),
  reason: z.string().optional(),
});
export type BulkTriageAccountOutcome = z.infer<typeof bulkTriageAccountOutcomeSchema>;

/**
 * `id` is the Client-generated idempotency key (a ULID, the same shape
 * `sync.ts`'s `QueuedMutation.id` is) — a retried request with the same id
 * replays the recorded response instead of re-applying, following the
 * `applied_mutations` ledger's pattern (`sync/mutations.ts`) rather than
 * widening that table for a shape it has no fields for (a per-account
 * breakdown, an undo-able thread-id list).
 */
export const bulkTriageBatchRequestSchema = z.object({
  id: z.string(),
  action: bulkTriageActionSchema,
  target: bulkTriageTargetSchema,
});
export type BulkTriageBatchRequest = z.infer<typeof bulkTriageBatchRequestSchema>;

/**
 * `batchId` is `id` echoed back — the identifier `POST /bulk-triage/undo`
 * takes, within `BULK_TRIAGE_UNDO_WINDOW_SECONDS` of this response.
 * `affectedCount` is the true total across every applied account, for the
 * Undo toast (#67: "the response names how many Threads were affected").
 */
export const bulkTriageBatchResponseSchema = z.object({
  batchId: z.string(),
  affectedCount: z.int(),
  accounts: z.array(bulkTriageAccountOutcomeSchema),
});
export type BulkTriageBatchResponse = z.infer<typeof bulkTriageBatchResponseSchema>;

export const bulkTriageUndoRequestSchema = z.object({ batchId: z.string() });
export type BulkTriageUndoRequest = z.infer<typeof bulkTriageUndoRequestSchema>;

/**
 * `not_found` covers an unknown id and one belonging to another User alike —
 * there is nothing to distinguish for the Client either way. `expired` is
 * the ordinary "the toast is long gone" case, past
 * `BULK_TRIAGE_UNDO_WINDOW_SECONDS`. `undone` is also the idempotent replay
 * of an undo already applied — retrying it is always safe.
 */
export const bulkTriageUndoResponseSchema = z.object({
  status: z.enum(["undone", "expired", "not_found"]),
  affectedCount: z.int(),
});
export type BulkTriageUndoResponse = z.infer<typeof bulkTriageUndoResponseSchema>;
