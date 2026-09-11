import { z } from "zod";

/**
 * The wire shape of a Note's body (#191, ADR-0024): BlockNote's own block
 * document — an array of top-level blocks, each carrying `id`, `type`,
 * `props`, inline `content` and nested `children` — never a second document
 * model invented for the wire. Deliberately loose in the manner of
 * ADR-0013's compose schema: a block whose `type` this file doesn't
 * recognise, or whose props don't match the shape a recognised `type`
 * expects, still round-trips as an opaque block rather than failing the
 * whole document — that is what makes a future BlockNote upgrade that adds
 * a block type (or widens an existing one) additive here, not a wire-schema
 * break. What *is* enforced here is the "In" side of the table
 * `mail#191`'s ticket body specs out: which block types and prop shapes this
 * app's editor (`apps/client/src/notes/`) actually produces. The editor's
 * own BlockNote schema is the other half of that enforcement — restricting
 * what the slash menu and formatting toolbar can reach — same division
 * ADR-0013 draws for compose: "legality of a given node/mark type is the
 * [editor] schema's job... enforced where the document is authored; this
 * package only needs to move the JSON around intact."
 */

/** BlockNote's inline content: styled text or a link wrapping styled text. Loose for the same reason `NoteBlock` is — a style key this file doesn't know is still preserved verbatim. */
export interface NoteInlineContent {
  type: string;
  text?: string;
  styles?: Record<string, unknown>;
  href?: string;
  content?: NoteInlineContent[];
}

const noteInlineContentSchema: z.ZodType<NoteInlineContent> = z.lazy(() =>
  z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    styles: z.record(z.string(), z.unknown()).optional(),
    href: z.string().optional(),
    content: z.array(noteInlineContentSchema).optional(),
  }),
);

/** The opaque fallback: any block, any props, structurally valid — what a `type` this file doesn't recognise (or a recognised `type` in a shape it doesn't recognise, e.g. a merged table cell) parses as instead of failing the document. */
export interface NoteBlock {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: NoteInlineContent[] | Record<string, unknown>;
  children: NoteBlock[];
}

const noteBlockSchema: z.ZodType<NoteBlock> = z.lazy(() =>
  z.looseObject({
    id: z.string(),
    type: z.string(),
    props: z.record(z.string(), z.unknown()),
    content: z
      .union([z.array(noteInlineContentSchema), z.record(z.string(), z.unknown())])
      .optional(),
    children: z.array(noteBlockSchema),
  }),
);

/**
 * The three props every default BlockNote block carries
 * (`@blocknote/core`'s own `defaultProps`) — spread into each known type's
 * props shape below rather than centralised behind a shared schema object,
 * since `z.looseObject` takes a shape literal, not a composable schema.
 */
const defaultBlockPropsShape = {
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  textAlignment: z.enum(["left", "center", "right", "justify"]).optional(),
};

const textBlockContent = z.array(noteInlineContentSchema);

/** Paragraphs, bold/italic/underline/strike ride the inline content above — not a mark union of their own, matching how BlockNote itself represents them (a `styles` bag on styled text). */
const paragraphBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("paragraph"),
  props: z.looseObject(defaultBlockPropsShape),
  content: textBlockContent,
  children: z.array(noteBlockSchema),
});

/** Headings h1–h3 only (ticket's "In" column) — a level outside that range is a recognised type in an unrecognised shape, so it falls through to `noteBlockSchema`'s opaque parse rather than being rejected. Toggle headings are `isToggleable` on this same block in BlockNote; omitting it from the checked shape below is what keeps "Toggle blocks" out of this app's Notes the same way. */
const headingBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("heading"),
  props: z.looseObject({
    ...defaultBlockPropsShape,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  content: textBlockContent,
  children: z.array(noteBlockSchema),
});

const bulletListItemBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("bulletListItem"),
  props: z.looseObject(defaultBlockPropsShape),
  content: textBlockContent,
  children: z.array(noteBlockSchema),
});

const numberedListItemBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("numberedListItem"),
  props: z.looseObject(defaultBlockPropsShape),
  content: textBlockContent,
  children: z.array(noteBlockSchema),
});

/** BlockNote's tickable-lines block — labelled **Checklist** everywhere it appears in this app's editor (`apps/client/src/notes/`'s dictionary override), never "Task list"/"Check List" (BlockNote's own default). */
const checkListItemBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("checkListItem"),
  props: z.looseObject({
    ...defaultBlockPropsShape,
    checked: z.boolean(),
  }),
  content: textBlockContent,
  children: z.array(noteBlockSchema),
});

/** BlockNote's own block type name for a blockquote is `quote`. */
const quoteBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("quote"),
  props: z.looseObject(defaultBlockPropsShape),
  content: textBlockContent,
  children: z.array(noteBlockSchema),
});

const codeBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("codeBlock"),
  props: z.looseObject({
    language: z.string().optional(),
  }),
  content: textBlockContent,
  children: z.array(noteBlockSchema),
});

const tableCellSchema = z.looseObject({
  type: z.literal("tableCell"),
  props: z.looseObject({
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    textAlignment: z.enum(["left", "center", "right", "justify"]).optional(),
  }),
  content: textBlockContent,
});

/** Tables are In; merged cells (`colspan`/`rowspan`) are Out (ticket's table) — this app's editor never sets `tables.splitCells`, the BlockNote config merging requires, so it never produces one. A `colspan`/`rowspan` that shows up anyway (a document authored elsewhere) is still preserved, just as an unknown field on this cell's loose props rather than a shape this schema specifically models. */
const tableBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("table"),
  props: z.looseObject({
    textColor: z.string().optional(),
  }),
  content: z.looseObject({
    type: z.literal("tableContent"),
    columnWidths: z.array(z.number().optional()),
    headerRows: z.number().int().nonnegative().optional(),
    headerCols: z.number().int().nonnegative().optional(),
    rows: z.array(z.looseObject({ cells: z.array(tableCellSchema) })),
  }),
  children: z.array(noteBlockSchema),
});

/**
 * Thread Link (#195): the block "Add to Notes" (the Reader) inserts,
 * pointing back at a Thread. `props` carries the whole **snapshot** —
 * `subject`, `participants` (already flattened to one display string, the
 * same join `ThreadDetailPane.tsx` renders) and `date` (the Thread's
 * `lastMessageAt`, ISO) — plus `threadId` itself, so the block still reads
 * correctly after the Thread it names is deleted: nothing here is ever
 * re-read from mail to render (this ticket's own "never a live mail
 * excerpt"). BlockNote's own prop types are primitives only (no nested
 * array/object), which is what makes `participants` a pre-joined string
 * rather than the Thread's own `ThreadParticipant[]`.
 *
 * `content` is `undefined` (BlockNote's own `content: "none"` blocks never
 * carry one — `nodeToBlock.ts`'s own conversion), not the inline-content
 * array every text-bearing block above has: there is nothing here for a
 * User to type into, so there is nothing for BlockNote to serialise as this
 * block's own content. The BlockNote block spec that renders and inserts it
 * lives in `apps/client/src/notes/thread-link-block.tsx`.
 */
const threadLinkBlockSchema = z.looseObject({
  id: z.string(),
  type: z.literal("threadLink"),
  props: z.looseObject({
    ...defaultBlockPropsShape,
    threadId: z.string(),
    subject: z.string(),
    participants: z.string(),
    date: z.string(),
  }),
  content: z.undefined().optional(),
  children: z.array(noteBlockSchema),
});

/**
 * The full Note block document: a top-level array of blocks, each one of
 * the recognised "In" shapes above, or — for anything else, including a
 * recognised type in an unrecognised shape — the opaque `noteBlockSchema`
 * fallback. Order matters for `z.union`: a specific branch is tried first
 * and, on success, wins the parse, so a well-formed heading still comes back
 * typed as one; only a mismatch falls through to the generic block.
 */
const knownNoteBlockSchema = z.union([
  paragraphBlockSchema,
  headingBlockSchema,
  bulletListItemBlockSchema,
  numberedListItemBlockSchema,
  checkListItemBlockSchema,
  quoteBlockSchema,
  codeBlockSchema,
  tableBlockSchema,
  threadLinkBlockSchema,
  noteBlockSchema,
]);

export const noteDocumentSchema = z.array(knownNoteBlockSchema);
export type NoteDocument = NoteBlock[];

/** The empty document a brand-new Note opens with — one empty paragraph, same as BlockNote's own default. */
export const EMPTY_NOTE_DOCUMENT: NoteDocument = [
  {
    id: "initialBlockId",
    type: "paragraph",
    props: {},
    content: [],
    children: [],
  },
];

/**
 * `Note` (#192, ADR-0023): the whole-replicated, User-scoped collection a
 * Note rides. `id` is a **client-generated ULID** (`store/notes.ts#newNoteId`),
 * minted before any server round trip — the same "offline-derivable id"
 * reasoning `Composition`'s own id already uses — so `/notes/:noteId` and a
 * Command Palette hit resolve on a Note that has never synced. `labelIds`
 * mirrors `Thread.labelIds` (`Label` is User-scoped since #186, which is
 * exactly the precondition that lets a Note carry the same Labels mail
 * does). There is no `version`: unlike `Composition`, a Note's body never
 * rejects a write (see `sync.ts#documentSaveSchema`), so there is nothing
 * here for a Client to have read stale.
 *
 * `pinned` (#193): the grid's own Pinned/Others split — a structural intent
 * with a real inverse (`pinNote`/`unpinNote`, `sync.ts#userMutationIntentSchema`),
 * the same "ordinary Optimistic Action" shape `labelNote`/`unlabelNote`
 * already have, not the Thread-style absolute-boolean-set `setPinned`.
 *
 * `deletedAt` (#194): soft delete and Recently Deleted. Set by `trashNote`,
 * cleared by its real inverse `restoreNote` (`sync.ts#userMutationIntentSchema`,
 * ADR-0019) — the same structural-intent shape `pinned` above already has,
 * not a physical row removal. A Note has no upstream, so a restore is
 * always exact: the same row comes back, Labels and `pinned` untouched,
 * because they were never touched by the delete either. The row keeps
 * syncing normally while `deletedAt` is set (it is an ordinary field, not a
 * tombstone) — `store/notes.ts#readNotes` filters it out of the grid and
 * `readDeletedNotes` is the one reader that wants it. `NOTE_TRASH_RETENTION_DAYS`
 * after this is stamped, `sync/note-purge.ts` on the Sync Backend physically
 * deletes the row and records the ordinary tombstone `deleteNote` already
 * would — Recently Deleted's window is a purge delay, not a second undo
 * window like the toast's own ten seconds.
 */
export const noteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  document: noteDocumentSchema,
  labelIds: z.array(z.string()),
  pinned: z.boolean(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Note = z.infer<typeof noteSchema>;

/** How long a soft-deleted Note stays in Recently Deleted before `sync/note-purge.ts` purges it for good (#194's own acceptance line: "30 days"). */
export const NOTE_TRASH_RETENTION_DAYS = 30;

/**
 * A Note's body save rides the `documentSaves` channel (#250, generalizing
 * #192's Note-only `noteSaves`) as a `DocumentSave` at `collection: "Note"`
 * — see `sync.ts#documentSaveSchema`'s own doc comment for the channel's
 * shape and its "never rejects" contract.
 */
