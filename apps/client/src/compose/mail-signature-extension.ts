import { Node } from "@tiptap/core";

/**
 * The per-Mail-Account signature (#47, compose-spec §Signature): "inserted
 * into the document when the composer opens, as a distinct schema node ...
 * visible, editable, trimmable." A plain container — `paragraph+`, not an
 * atom — is what makes it both things at once: ordinary text editing works
 * inside it (trimming a line, per compose-spec "the single most common thing
 * anyone does to one"), and selecting past its edges and deleting removes
 * the whole block, which is what "deleting it sticks" means once the result
 * autosaves like any other document edit.
 *
 * `mail-serializer.ts` gives this exactly one thing HTML rendering doesn't
 * need and plaintext does: the RFC 3676 `-- ` sigdash, which is why it is a
 * distinct node type rather than plain paragraphs the composer could not
 * tell apart from the rest of the body.
 */
export const MailSignature = Node.create({
  name: "mailSignature",
  group: "block",
  content: "paragraph+",

  parseHTML() {
    return [{ tag: "div[data-mail-signature]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      { "data-mail-signature": "true", class: "mail-signature", ...HTMLAttributes },
      0,
    ];
  },
});

/** Splits a plain-text signature into one paragraph node per line (blank lines become empty paragraphs). */
export function signatureDocumentNode(signature: string): {
  type: "mailSignature";
  content: { type: "paragraph"; content?: { type: "text"; text: string }[] }[];
} {
  const lines = signature.split("\n");
  return {
    type: "mailSignature",
    content: lines.map((line) =>
      line.length > 0
        ? { type: "paragraph", content: [{ type: "text", text: line }] }
        : { type: "paragraph" },
    ),
  };
}
