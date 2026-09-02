import { generateJSON, Node, type NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import DOMPurify from "dompurify";
import { useState } from "react";
import { Pictogram } from "../brand/Pictogram.js";

/**
 * The Quoted Original (#47, ADR-0013, CONTEXT.md): "the earlier message
 * carried into a reply or forward, kept exactly as it arrived rather than
 * re-written into the User's own formatting." One opaque atom node whose
 * `html` attr is the *exact* string this composer was seeded with — never
 * touched by the mail serialiser (`compose/mail-serializer.ts`'s own
 * `mailQuote` case emits it verbatim) or by anything in this file, which is
 * what makes "byte-identical unless the escape is used" true. The on-screen
 * preview below sanitizes a **copy** for display only.
 *
 * Collapsed by default behind a `···` expander; deletable whole like any
 * other node (select it, press Backspace/Delete); "Edit quoted text" is the
 * one-way escape that converts it into ordinary schema nodes, a lossy import
 * exercised through `generateJSON` against this same editor's own schema —
 * the same import path a real reply's sender HTML would take if we ever
 * needed to display it as authored content.
 */
export const MailQuote = Node.create({
  name: "mailQuote",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      html: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-mail-quote]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // Never reached by the outgoing mail path (the mail serialiser walks the
    // document directly, ADR-0013) — this is only what TipTap would emit if
    // asked to serialize its own DOM, which nothing here does on purpose.
    return ["div", { "data-mail-quote": "true", ...HTMLAttributes }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MailQuoteView);
  },
});

function MailQuoteView({ node, editor, getPos }: NodeViewProps) {
  const [expanded, setExpanded] = useState(false);
  const html = typeof node.attrs.html === "string" ? node.attrs.html : "";

  const editQuotedText = () => {
    const pos = typeof getPos === "function" ? getPos() : null;
    if (pos === null || pos === undefined) return;
    // The one-way escape (compose-spec): lossily re-imports the sender's raw
    // HTML through this editor's own schema, so what results is ordinary,
    // editable content — never the atom again.
    const parsed = generateJSON(html, editor.extensionManager.extensions) as {
      content?: unknown[];
    };
    const content =
      Array.isArray(parsed.content) && parsed.content.length > 0
        ? parsed.content
        : [{ type: "paragraph" }];
    editor
      .chain()
      .focus()
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .insertContentAt(pos, [{ type: "blockquote", content }])
      .run();
  };

  return (
    <NodeViewWrapper className="mail-quote" data-drag-handle={false}>
      <div className="mail-quote-controls" contentEditable={false}>
        <button
          type="button"
          className="mail-quote-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          <Pictogram name="chevron-right" size={14} className={expanded ? "expanded" : ""} />
          {expanded ? "Hide quoted text" : "···"}
        </button>
        <button type="button" className="mail-quote-edit" onClick={editQuotedText}>
          <Pictogram name="pen" size={12} /> Edit quoted text
        </button>
      </div>
      {expanded ? (
        <div
          className="mail-quote-preview"
          contentEditable={false}
          // Display-only sanitize pass (the reading pane's own "third pass"
          // convention, `mail/reading/MessageBody.tsx`) — `node.attrs.html`
          // itself is never mutated, so the outgoing mail is unaffected.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized immediately above, display-only
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}
