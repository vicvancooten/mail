import { Editor, type JSONContent } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { MailSignature, signatureDocumentNode } from "./mail-signature-extension.js";

/**
 * `mailSignature`'s own acceptance line (#47, compose-spec §Signature):
 * "visible, editable, trimmable" and "deleting it sticks." Exercised
 * through a real `@tiptap/core` `Editor` and its own ProseMirror commands
 * rather than simulated DOM events — jsdom's `input`/`keydown` events do not
 * drive ProseMirror's view, only genuine browser input does, so this is the
 * one honest way to assert the *result* of an edit without a full browser.
 */

let editor: Editor | undefined;

afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

function makeEditor(content: object) {
  editor = new Editor({
    extensions: [StarterKit, MailSignature],
    content,
  });
  return editor;
}

/** The ProseMirror position range spanning one node type's first occurrence — avoids hand-counting offsets. */
function rangeOfFirst(e: Editor, type: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  e.state.doc.descendants((node, pos) => {
    if (range) return false;
    if (node.type.name === type) {
      range = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  if (!range) throw new Error(`no ${type} node in document`);
  return range;
}

describe("MailSignature", () => {
  it("splits a plain-text signature into one paragraph per line", () => {
    expect(signatureDocumentNode("Ada Lovelace\nComputing pioneer")).toEqual({
      type: "mailSignature",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Ada Lovelace" }] },
        { type: "paragraph", content: [{ type: "text", text: "Computing pioneer" }] },
      ],
    });
  });

  it("a blank line becomes an empty paragraph, not a dropped one", () => {
    expect(signatureDocumentNode("Ada\n\nLovelace").content).toHaveLength(3);
  });

  it("is editable — a normal text command inside it changes its content", () => {
    const doc = {
      type: "doc",
      content: [signatureDocumentNode("Ada"), { type: "paragraph" }],
    };
    const e = makeEditor(doc);
    const { to } = rangeOfFirst(e, "text"); // right after "Ada"
    e.commands.setTextSelection(to);
    e.commands.insertContent(" Lovelace");
    const content: JSONContent[] = e.getJSON().content ?? [];
    const signature: JSONContent | undefined = content.find(
      (node) => node.type === "mailSignature",
    );
    const firstParagraph: JSONContent | undefined = signature?.content?.[0];
    const firstText: JSONContent | undefined = firstParagraph?.content?.[0];
    expect(firstText?.text).toBe("Ada Lovelace");
  });

  it("deleting it sticks: selecting past its edges and deleting removes the whole node", () => {
    const doc = {
      type: "doc",
      content: [
        signatureDocumentNode("Ada"),
        { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      ],
    };
    const e = makeEditor(doc);
    expect(e.getJSON().content?.some((node) => node.type === "mailSignature")).toBe(true);

    // Deletes the exact node range the signature occupies — `deleteRange`
    // (unlike `setTextSelection`+`deleteSelection`) works directly against
    // block-node boundaries, the same span a User dragging a selection over
    // the whole signature block and pressing Backspace would produce.
    const { from, to } = rangeOfFirst(e, "mailSignature");
    e.commands.deleteRange({ from, to });

    const result = e.getJSON();
    expect(result.content?.some((node) => node.type === "mailSignature")).toBe(false);
    expect(e.getText()).toContain("Body");
  });
});
