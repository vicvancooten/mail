import type { NoteBlock, NoteDocument } from "@mail/shared";
import { describe, expect, it } from "vitest";
import {
  deriveNoteTitle,
  flattenBlockText,
  notePreviewBlocks,
  UNTITLED_NOTE_PLACEHOLDER,
} from "./note-text.js";

function paragraph(text: string, id = "b1"): NoteBlock {
  return {
    id,
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

function checkListItem(text: string, checked: boolean, id = "b1"): NoteBlock {
  return {
    id,
    type: "checkListItem",
    props: { checked },
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

function tableWithFirstCell(text: string, id = "b1"): NoteBlock {
  return {
    id,
    type: "table",
    props: {},
    content: {
      type: "tableContent",
      columnWidths: [undefined, undefined],
      rows: [
        {
          cells: [
            { type: "tableCell", props: {}, content: [{ type: "text", text, styles: {} }] },
            {
              type: "tableCell",
              props: {},
              content: [{ type: "text", text: "second", styles: {} }],
            },
          ],
        },
      ],
    },
    children: [],
  };
}

describe("flattenBlockText", () => {
  it("flattens styled text, marks stripped", () => {
    const block: NoteBlock = {
      id: "b1",
      type: "paragraph",
      props: {},
      content: [
        { type: "text", text: "Hello ", styles: { bold: true } },
        { type: "text", text: "world", styles: {} },
      ],
      children: [],
    };

    expect(flattenBlockText(block)).toBe("Hello world");
  });

  it("reads a Checklist item as text like any block", () => {
    expect(flattenBlockText(checkListItem("Buy milk", true))).toBe("Buy milk");
  });

  it("flattens a link's own inline content", () => {
    const block: NoteBlock = {
      id: "b1",
      type: "paragraph",
      props: {},
      content: [
        {
          type: "link",
          href: "https://example.test",
          content: [{ type: "text", text: "a link", styles: {} }],
        },
      ],
      children: [],
    };

    expect(flattenBlockText(block)).toBe("a link");
  });

  it("reads a table's first cell as text like any block", () => {
    expect(flattenBlockText(tableWithFirstCell("First cell"))).toBe("First cell");
  });

  it("is empty for a block with no text of its own", () => {
    expect(flattenBlockText(paragraph(""))).toBe("");
  });

  it("is empty for an opaque block whose content this app doesn't recognise", () => {
    const block: NoteBlock = {
      id: "b1",
      type: "someBrandNewBlockNoteBlock",
      props: {},
      content: { arbitrary: "shape" },
      children: [],
    };

    expect(flattenBlockText(block)).toBe("");
  });
});

describe("deriveNoteTitle", () => {
  it("is the first block's own flattened text", () => {
    const document: NoteDocument = [paragraph("Grocery list"), paragraph("Milk", "b2")];

    expect(deriveNoteTitle(document)).toBe("Grocery list");
  });

  it("shows the transient placeholder for a first block with no text", () => {
    expect(deriveNoteTitle([paragraph("")])).toBe(UNTITLED_NOTE_PLACEHOLDER);
  });

  it("shows the placeholder for whitespace-only text too", () => {
    expect(deriveNoteTitle([paragraph("   ")])).toBe(UNTITLED_NOTE_PLACEHOLDER);
  });

  it("shows the placeholder for a genuinely empty document", () => {
    expect(deriveNoteTitle([])).toBe(UNTITLED_NOTE_PLACEHOLDER);
  });

  it("reads a table's first cell as the title, like any other block", () => {
    expect(deriveNoteTitle([tableWithFirstCell("Budget")])).toBe("Budget");
  });
});

describe("notePreviewBlocks", () => {
  it("keeps every block when the document is short", () => {
    const document: NoteDocument = [paragraph("one", "b1"), paragraph("two", "b2")];

    expect(notePreviewBlocks(document)).toEqual(document);
  });

  it("stops at the block-count budget", () => {
    const document: NoteDocument = Array.from({ length: 10 }, (_, index) =>
      paragraph(`block ${index}`, `b${index}`),
    );

    expect(notePreviewBlocks(document, 6, 10_000)).toHaveLength(6);
  });

  it("stops once the flattened character budget is met", () => {
    const document: NoteDocument = [
      paragraph("a".repeat(200), "b1"),
      paragraph("b".repeat(200), "b2"),
      paragraph("c".repeat(200), "b3"),
    ];

    const preview = notePreviewBlocks(document, 6, 280);

    expect(preview.map((block) => block.id)).toEqual(["b1", "b2"]);
  });

  it("always keeps the first block, even alone past the character budget", () => {
    const document: NoteDocument = [paragraph("a".repeat(400), "b1"), paragraph("short", "b2")];

    expect(notePreviewBlocks(document, 6, 280).map((block) => block.id)).toEqual(["b1"]);
  });

  it("is empty for an empty document", () => {
    expect(notePreviewBlocks([])).toEqual([]);
  });
});
