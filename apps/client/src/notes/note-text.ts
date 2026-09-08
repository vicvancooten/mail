import type { NoteBlock, NoteDocument, NoteInlineContent } from "@mail/shared";

/**
 * The grid's own plain-text projection of a Note's block document (#193):
 * the derived title (the first block, flattened) and a card's preview
 * (a leading slice of blocks, capped so the read-only `NoteEditor` under it
 * never has to render a whole Note). Neither of these is ever written back
 * into the document — both are recomputed on every render, straight from
 * `Note.document`, the same "transient, never persisted" posture the
 * ticket's own acceptance line asks of "Untitled Note".
 */

/** The transient placeholder a Note with no title text shows — never written into the document (the ticket's own words). */
export const UNTITLED_NOTE_PLACEHOLDER = "Untitled Note";

/** A table block's own shape (`@mail/shared#notes.ts`'s `tableBlockSchema`) — narrowed here just enough to reach the first cell's own inline content. */
interface NoteTableContent {
  type: "tableContent";
  rows?: readonly { cells?: readonly { content?: NoteInlineContent[] }[] }[];
}

function isTableContent(content: unknown): content is NoteTableContent {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as { type?: unknown }).type === "tableContent"
  );
}

function flattenInlineContent(content: readonly NoteInlineContent[]): string {
  return content
    .map((entry) => entry.text ?? (entry.content ? flattenInlineContent(entry.content) : ""))
    .join("");
}

/**
 * One block's inline content flattened to plain text, marks stripped —
 * the ticket's own "a Checklist item or a table's first cell read as text
 * like any block". A text-bearing block's `content` is already the inline
 * array every other flatten call reads; a `table` block's is instead the
 * `tableContent` object (`notes.ts#tableBlockSchema`), so its first row's
 * first cell stands in for "this block's text" — reading a table as its
 * lead cell is a deliberate simplification, not a summary of the whole
 * table. Any other shape (an opaque, unrecognised block's `content`) simply
 * has no text of its own.
 */
export function flattenBlockText(block: NoteBlock): string {
  const { content } = block;
  if (Array.isArray(content)) return flattenInlineContent(content);
  if (isTableContent(content)) {
    const firstCellContent = content.rows?.[0]?.cells?.[0]?.content;
    return firstCellContent ? flattenInlineContent(firstCellContent) : "";
  }
  return "";
}

/** The card's derived title (#193): the first block's own text, or the transient "Untitled Note" placeholder when it has none — never a summary of the whole document. */
export function deriveNoteTitle(document: NoteDocument): string {
  const [first] = document;
  const text = first ? flattenBlockText(first).trim() : "";
  return text.length > 0 ? text : UNTITLED_NOTE_PLACEHOLDER;
}

/** #193's own default preview budget: "roughly the first six blocks or 280 characters of flattened text, whichever comes first." */
export const PREVIEW_MAX_BLOCKS = 6;
export const PREVIEW_MAX_CHARS = 280;

/**
 * The leading slice of `document` a card's read-only preview renders
 * (through the same `NoteEditor`, #191's own acceptance line — this
 * function only picks *which* blocks, never a second renderer). Whole
 * blocks only: the budget is a stopping point checked between blocks, not a
 * mid-block text truncation, which is what "roughly" allows for in the
 * ticket's own wording. The first block is always kept even if it alone
 * already exceeds the character budget, so a preview is never empty for a
 * Note whose first block happens to be long.
 */
export function notePreviewBlocks(
  document: NoteDocument,
  maxBlocks: number = PREVIEW_MAX_BLOCKS,
  maxChars: number = PREVIEW_MAX_CHARS,
): NoteDocument {
  const result: NoteBlock[] = [];
  let chars = 0;
  for (const block of document) {
    if (result.length > 0 && (result.length >= maxBlocks || chars >= maxChars)) break;
    result.push(block);
    chars += flattenBlockText(block).length;
  }
  return result;
}
