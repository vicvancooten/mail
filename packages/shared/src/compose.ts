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
