import { describe, expect, it } from "vitest";
import { EMPTY_NOTE_DOCUMENT, type NoteDocument, noteDocumentSchema } from "./notes.js";

function paragraph(text: string) {
  return {
    id: "b1",
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

describe("noteDocumentSchema", () => {
  it("accepts the empty document a brand-new Note opens with", () => {
    expect(noteDocumentSchema.parse(EMPTY_NOTE_DOCUMENT)).toEqual(EMPTY_NOTE_DOCUMENT);
  });

  it("round-trips every In-column block type", () => {
    const doc: NoteDocument = [
      paragraph("hello"),
      {
        id: "b2",
        type: "heading",
        props: { level: 2 },
        content: [{ type: "text", text: "Section", styles: { bold: true } }],
        children: [],
      },
      {
        id: "b3",
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "item", styles: {} }],
        children: [],
      },
      {
        id: "b4",
        type: "numberedListItem",
        props: {},
        content: [{ type: "text", text: "item", styles: {} }],
        children: [],
      },
      {
        id: "b5",
        type: "checkListItem",
        props: { checked: true },
        content: [{ type: "text", text: "done", styles: {} }],
        children: [],
      },
      {
        id: "b6",
        type: "quote",
        props: {},
        content: [{ type: "text", text: "quoted", styles: {} }],
        children: [],
      },
      {
        id: "b7",
        type: "codeBlock",
        props: { language: "ts" },
        content: [{ type: "text", text: "const x = 1;", styles: {} }],
        children: [],
      },
      {
        id: "b8",
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          columnWidths: [undefined, undefined],
          rows: [{ cells: [{ type: "tableCell", props: {}, content: [] }] }],
        },
        children: [],
      },
      {
        id: "b9",
        type: "threadLink",
        props: {
          threadId: "thread-1",
          subject: "Quarterly numbers",
          participants: "Ada Lovelace, Grace Hopper",
          date: "2026-06-25T09:00:00.000Z",
        },
        children: [],
      },
    ];

    expect(noteDocumentSchema.parse(doc)).toEqual(doc);
  });

  it("preserves unknown fields on a known block's props verbatim", () => {
    const doc = [
      {
        id: "b1",
        type: "paragraph",
        props: { aFutureProp: "kept" },
        content: [],
        children: [],
      },
    ];

    expect(noteDocumentSchema.parse(doc)).toEqual(doc);
  });

  it("preserves an unrecognised block type verbatim rather than rejecting the document", () => {
    const doc = [
      {
        id: "b1",
        type: "callout",
        props: { icon: "💡" },
        content: [{ type: "text", text: "future block", styles: {} }],
        children: [],
      },
    ];

    expect(noteDocumentSchema.parse(doc)).toEqual(doc);
  });

  it("falls back to the opaque shape for a recognised type in an unrecognised form, rather than rejecting", () => {
    const doc = [
      {
        id: "b1",
        type: "heading",
        props: { level: 4 },
        content: [{ type: "text", text: "Too deep", styles: {} }],
        children: [],
      },
    ];

    expect(noteDocumentSchema.parse(doc)).toEqual(doc);
  });

  it("preserves a merged table cell (colspan/rowspan) verbatim rather than rejecting", () => {
    const doc = [
      {
        id: "b1",
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          columnWidths: [undefined],
          rows: [
            {
              cells: [{ type: "tableCell", props: { colspan: 2 }, content: [] }],
            },
          ],
        },
        children: [],
      },
    ];

    expect(noteDocumentSchema.parse(doc)).toEqual(doc);
  });

  it("rejects nothing structurally sound it merely doesn't recognise — an entirely unfamiliar document still parses", () => {
    const doc = [
      {
        id: "b1",
        type: "someBrandNewBlockNoteBlock",
        props: { anything: [1, 2, 3], nested: { ok: true } },
        content: { arbitrary: "shape" },
        children: [],
      },
    ];

    expect(() => noteDocumentSchema.parse(doc)).not.toThrow();
    expect(noteDocumentSchema.parse(doc)).toEqual(doc);
  });
});
