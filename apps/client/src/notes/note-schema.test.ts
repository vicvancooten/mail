import { describe, expect, it } from "vitest";
import { noteDictionary, noteSchema } from "./note-schema.js";

describe("noteSchema", () => {
  it("registers exactly the In column's block types, plus Thread Link (#195)", () => {
    expect(Object.keys(noteSchema.blockSchema).sort()).toEqual(
      [
        "paragraph",
        "heading",
        "bulletListItem",
        "numberedListItem",
        "checkListItem",
        "quote",
        "codeBlock",
        "table",
        "threadLink",
      ].sort(),
    );
  });

  it("gives Thread Link no editable content — a snapshot chip, never a live mail excerpt", () => {
    expect(noteSchema.blockSchema.threadLink.content).toBe("none");
  });

  it("restricts headings to levels 1-3, with no toggle-heading prop", () => {
    const level = noteSchema.blockSchema.heading.propSchema.level as {
      values?: readonly number[];
    };
    expect(level.values).toEqual([1, 2, 3]);
    expect(noteSchema.blockSchema.heading.propSchema).not.toHaveProperty("isToggleable");
  });

  it("registers exactly the In column's marks — no code/textColor/backgroundColor", () => {
    expect(Object.keys(noteSchema.styleSchema).sort()).toEqual(
      ["bold", "italic", "underline", "strike"].sort(),
    );
  });

  it("registers text and link inline content, no mention", () => {
    expect(Object.keys(noteSchema.inlineContentSchema).sort()).toEqual(["link", "text"]);
  });

  it("renames Check List to Checklist in the shared dictionary", () => {
    expect(noteDictionary.slash_menu.check_list.title).toBe("Checklist");
  });
});
