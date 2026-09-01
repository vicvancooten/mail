import { z } from "zod";

/**
 * The wire shape of a Composition's body (ADR-0013): the editor's own
 * ProseMirror document, never HTML. Deliberately loose — legality of a given
 * node/mark `type` is the TipTap schema's job (`apps/client/src/compose/`),
 * enforced where the document is authored; this package only needs to move
 * the JSON around intact between the Client and the Sync Backend, which is
 * what makes a future node type additive here with no wire-schema change.
 * The backend's mail serialiser is the one place that *does* care what a
 * `type` means, and it treats an unrecognized one as inert (ADR-0013:
 * "unsupported constructs normalise") rather than failing the whole push.
 */
export interface ComposeMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ComposeNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ComposeNode[];
  marks?: ComposeMark[];
  text?: string;
}

export interface ComposeDocument {
  type: "doc";
  content: ComposeNode[];
}

const composeMarkSchema: z.ZodType<ComposeMark> = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const composeNodeSchema: z.ZodType<ComposeNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(composeNodeSchema).optional(),
    marks: z.array(composeMarkSchema).optional(),
    text: z.string().optional(),
  }),
);

export const composeDocumentSchema: z.ZodType<ComposeDocument> = z.object({
  type: z.literal("doc"),
  content: z.array(composeNodeSchema),
});

/** The empty document a brand-new Composition opens with — one empty paragraph, same as TipTap's own default. */
export const EMPTY_COMPOSE_DOCUMENT: ComposeDocument = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/**
 * The fixed ~8-value colour palette (ADR-0013: "a fixed ~8-value palette
 * rather than a free hex picker, so every value can be vetted once for
 * legibility against a recipient client that inverts for dark mode").
 * Shared between the editor's swatch pickers (`apps/client/src/compose/`)
 * and the mail serialiser, so a value the toolbar ever offered is always one
 * the outgoing HTML already knows is legible.
 */
export const COMPOSE_TEXT_COLORS = [
  { name: "gray", value: "#6b7280" },
  { name: "red", value: "#dc2626" },
  { name: "orange", value: "#d97706" },
  { name: "yellow", value: "#a16207" },
  { name: "green", value: "#16a34a" },
  { name: "blue", value: "#2563eb" },
  { name: "purple", value: "#7c3aed" },
  { name: "pink", value: "#db2777" },
] as const;

export const COMPOSE_HIGHLIGHT_COLORS = [
  { name: "gray", value: "#e5e7eb" },
  { name: "red", value: "#fecaca" },
  { name: "orange", value: "#fed7aa" },
  { name: "yellow", value: "#fef08a" },
  { name: "green", value: "#bbf7d0" },
  { name: "blue", value: "#bfdbfe" },
  { name: "purple", value: "#e9d5ff" },
  { name: "pink", value: "#fbcfe8" },
] as const;

/**
 * One `To`/`Cc`/`Bcc` recipient. Defined independently of `sync.ts`'s
 * `ThreadParticipant` (same `{name, address}` shape) rather than imported
 * from it, so this file never depends on `sync.ts` — `sync.ts` is the one
 * that depends on this file for its `compositions` request/response fields,
 * and a two-way import between them would be circular.
 */
export const recipientSchema = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type Recipient = z.infer<typeof recipientSchema>;

/**
 * One autosave of a Composition, as it rides `POST /sync` (ADR-0014). This
 * is deliberately **not** a `MutationIntent`: intents are additive and FIFO
 * (`sync.ts`'s own doc comment), and autosave is the one thing ADR-0014
 * names as the exception — coalesced, last-write-wins per Composition. It
 * therefore rides its own `compositions` array alongside `mutations` rather
 * than joining that union.
 *
 * `id` is the Composition's own id — Client-generated (ULID) the moment a
 * compose surface first gets content, same "offline-derivable id" shape
 * `labelId` uses for Labels — so autosave never waits on a round trip for an
 * id to exist. `saveId` is a *second*, fresh ULID minted for this specific
 * save attempt: the idempotency key a retried `POST /sync` replays against
 * (`sync/compose-store.ts`'s ledger), independent of `version` so a dropped
 * response can be told apart from a genuine concurrent edit on another
 * device. `version` is the Composition version this save was composed
 * against — a stale one (ADR-0012: "each autosave carries the version it
 * read") is rejected as a conflict rather than silently overwriting text
 * typed elsewhere.
 */
export const composeSaveSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  version: z.number().int().nonnegative(),
  subject: z.string(),
  document: composeDocumentSchema,
  to: z.array(recipientSchema),
  cc: z.array(recipientSchema),
  bcc: z.array(recipientSchema),
});
export type ComposeSave = z.infer<typeof composeSaveSchema>;

/**
 * One save's outcome. `applied` covers both "just applied" and "a retry of
 * an id already applied" (the ledger replays its recorded `version` either
 * way), matching `MutationOutcome`'s own idempotency contract. `conflict` is
 * ADR-0012's "stale write rejected" path — `version` is the Composition's
 * *current* version, so a future conflict UI has something to reconcile
 * against. `rejected` is permanent (e.g. the Composition or Mail Account is
 * gone) and, like a rejected `MutationIntent`, is never retried.
 */
export const composeSaveOutcomeSchema = z.object({
  id: z.string(),
  saveId: z.string(),
  status: z.enum(["applied", "conflict", "rejected"]),
  version: z.number().int().nonnegative(),
  reason: z.string().optional(),
});
export type ComposeSaveOutcome = z.infer<typeof composeSaveOutcomeSchema>;

/**
 * The per-User Undo Send delay (ADR-0007, poc-spec.md §Compose & sending):
 * `off/5/10/20/30` seconds, default 10. **`off` is `N = 0`, not a bypass** —
 * ADR-0007 rejected "delay `off` as a synchronous bypass" outright, because
 * retry, the Needs Reauth hold and failure-to-Draft would each need a second
 * implementation on the path least likely to be exercised in testing. A
 * zero-delay send still creates the Pending Send row; the sweeper simply
 * finds it already due.
 *
 * Held per User in the Sync Backend rather than sent up with the send
 * itself, because ADR-0007's "the delay is measured from server receipt,
 * never from the Client's clock" makes `submit_after` the server's to
 * compute. #54 (Preferences) migrates this into the general User-scoped
 * preference collection; this is the inline default it will read from.
 */
export const UNDO_SEND_DELAY_OPTIONS = [0, 5, 10, 20, 30] as const;
export const DEFAULT_UNDO_SEND_DELAY_SECONDS = 10;

export const undoSendDelaySchema = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(10),
  z.literal(20),
  z.literal(30),
]);
export type UndoSendDelaySeconds = z.infer<typeof undoSendDelaySchema>;

export const sendSettingsSchema = z.object({
  undoSendDelaySeconds: undoSendDelaySchema,
});
export type SendSettings = z.infer<typeof sendSettingsSchema>;

/**
 * A Composition's status (ADR-0012: "one entity, two states"), which
 * ADR-0007's state machine `pending → submitting → sent | failed |
 * cancelled` is expressed over.
 *
 * Two of those five ADR-0007 words are not statuses here, and deliberately:
 *
 * - **`cancelled` is `draft`.** ADR-0007's own consequence is "cancelling
 *   restores a Draft", and ADR-0012 amends the design to a single row whose
 *   status spans both, so a cancel is literally a status change back to
 *   `draft` — there is no third state to be in.
 * - **A permanent rejection is also `draft`,** badged. ADR-0007: "permanent
 *   rejections fail the send and restore it as a Draft with the server's
 *   rejection text." The badge is `sendError` below, not the status: keeping
 *   exactly one status that means "editable" is what lets autosave
 *   (`sync/compose-store.ts`), the Drafts view and the IMAP draft push all
 *   keep one code path instead of each learning a second draft-like state.
 *   `failed` therefore stays reserved in the enum ADR-0012 names, for a
 *   future terminal failure that is *not* returned to the User to edit.
 */
export const compositionStatusSchema = z.enum(["draft", "pending", "submitting", "sent", "failed"]);
export type CompositionStatus = z.infer<typeof compositionStatusSchema>;

/** Statuses a Pending Send occupies — the countdown is live, and autosave has nothing left to write into. */
export const IN_FLIGHT_COMPOSITION_STATUSES: readonly CompositionStatus[] = [
  "pending",
  "submitting",
];

/**
 * An attachment's disposition (#48, ADR-0012): `attachment` for anything
 * dropped or picked, `inline` for an image pasted into the body — carries a
 * `contentId` either way so the mail serialiser can rewrite an inline
 * image's `src` to `cid:` at MIME-build time (`compose/mail-serializer.ts`),
 * while the editor keeps previewing it from the Blob Store's own download
 * route. The per-image toggle compose-spec describes just flips this field.
 */
export const attachmentDispositionSchema = z.enum(["attachment", "inline"]);
export type AttachmentDisposition = z.infer<typeof attachmentDispositionSchema>;

/**
 * One attachment's metadata as it rides the `Composition` (ADR-0012: "a
 * single Composition row carries ... attachment references"). The bytes
 * themselves never leave the Blob Store except through the download route —
 * this is only what the composer needs to render a row and what the mail
 * serialiser needs to build a MIME part.
 */
export const attachmentMetaSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  disposition: attachmentDispositionSchema,
  /** Non-null exactly when `disposition` is `inline` — what an authored `cid:` reference resolves against. */
  contentId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

/**
 * The instance-level attachment budget (ADR-0012: "size limits are
 * instance-level config, defaulting to 25MB of encoded message size"),
 * served by `GET /compose-config` so the Client can enforce it live at
 * selection without a round trip per file.
 */
export const composeConfigSchema = z.object({
  attachmentBudgetEncodedBytes: z.number().int().positive(),
});
export type ComposeConfig = z.infer<typeof composeConfigSchema>;

/**
 * Base64's 3-bytes-in/4-chars-out inflation (compose-spec: "25MB encoded ≈
 * 18MB of files") — the one formula the Client's live budget check and the
 * Sync Backend's own re-check both run, so the two can never disagree about
 * what "encoded size" means.
 */
export function encodedByteSize(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * The wire projection of a Composition (#46): the `Composition` collection
 * ADR-0011's `/sync` serves per Mail Account, which is what makes a Pending
 * Send "visible and cancellable from every device the User has open"
 * (ADR-0007) rather than a countdown only the sending tab knows about.
 *
 * The whole document rides it, not just the send state: cancelling "restores
 * a Draft and reopens the composer on whichever device cancelled"
 * (ADR-0007), and a device that never typed the mail can only do that if it
 * holds the content. Compositions are a handful of rows per account, so this
 * is nothing like the bounded-window problem `Thread` has.
 *
 * `submitAfter` is the absolute instant the sweeper may claim this row —
 * absolute so "a boot-time sweep submits everything due, however long the
 * backend was down" (ADR-0007) needs no separate bookkeeping. `sendError` is
 * the SMTP rejection **verbatim** (compose-spec: "`550 5.7.1 relay denied`
 * is actionable, 'something went wrong' is not"), non-null exactly while a
 * Draft carries the "Send failed" badge. `messageId` is the id the Sync
 * Backend minted at claim time (compose-spec §Threading headers), sent up so
 * a Client can match its Composition to the Message that lands in `Sent`.
 */
export const compositionSchema = z.object({
  id: z.string(),
  mailAccountId: z.string(),
  status: compositionStatusSchema,
  subject: z.string(),
  document: composeDocumentSchema,
  to: z.array(recipientSchema),
  cc: z.array(recipientSchema),
  bcc: z.array(recipientSchema),
  version: z.number().int().nonnegative(),
  submitAfter: z.iso.datetime().nullable(),
  sendError: z.string().nullable(),
  messageId: z.string().nullable(),
  sentAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  /** The Blob Store's references for this Composition (#48) — metadata only, never bytes. */
  attachments: z.array(attachmentMetaSchema),
});
export type Composition = z.infer<typeof compositionSchema>;
