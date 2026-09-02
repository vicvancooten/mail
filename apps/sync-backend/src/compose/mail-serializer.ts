import type { ComposeDocument, ComposeMark, ComposeNode } from "@mail/shared";
import { htmlToText } from "html-to-text";

/**
 * The dedicated mail serialiser (ADR-0013): walks the Composition's
 * ProseMirror document directly, **never** the DOM the editor rendered, and
 * produces the two outgoing bodies `sync/draft-push.ts` (and, later, #46's
 * send path) hands to Nodemailer. Pure and side-effect free — no network, no
 * database — so the compose-spec's acceptance line ("serialised HTML uses
 * inline styles only; plaintext alternative present") is a property of this
 * file alone and testable without a Composition ever existing in Postgres.
 *
 * An unrecognized node `type` degrades by recursing into its `content`
 * (compose-spec: "unsupported constructs normalise") rather than throwing —
 * a schema this file doesn't yet know about (a future extension) never
 * breaks a push, it just loses its own formatting.
 */

const BODY_TEXT_COLOR = "#1a1a1a";
const BODY_BACKGROUND_COLOR = "#ffffff";
const BODY_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BORDER_COLOR = "#d0d0d0";
const QUOTE_BORDER_COLOR = "#c0c0c0";
const LINK_COLOR = "#2563eb";
const MUTED_TEXT_COLOR = "#555555";

export function serializeComposeHtml(doc: ComposeDocument): string {
  const body = doc.content.map((node) => renderBlockHtml(node)).join("");
  return (
    `<div style="color:${BODY_TEXT_COLOR};background-color:${BODY_BACKGROUND_COLOR};` +
    `font-family:${BODY_FONT_STACK};font-size:14px;line-height:1.5;">${body}</div>`
  );
}

function renderBlockHtml(node: ComposeNode): string {
  const align = typeof node.attrs?.textAlign === "string" ? node.attrs.textAlign : null;
  const alignStyle = align && align !== "left" ? `text-align:${align};` : "";

  switch (node.type) {
    case "paragraph":
      return `<p style="margin:0 0 1em 0;${alignStyle}">${renderInlineHtml(node.content) || "&nbsp;"}</p>`;

    case "heading": {
      const level = clampHeadingLevel(node.attrs?.level);
      const size = { 1: "24px", 2: "20px", 3: "17px" }[level];
      return (
        `<h${level} style="margin:0 0 0.6em 0;font-size:${size};font-weight:600;${alignStyle}">` +
        `${renderInlineHtml(node.content)}</h${level}>`
      );
    }

    case "bulletList":
      return `<ul style="margin:0 0 1em 0;padding-left:1.5em;">${renderListItems(node)}</ul>`;

    case "orderedList":
      return `<ol style="margin:0 0 1em 0;padding-left:1.5em;">${renderListItems(node)}</ol>`;

    case "taskList":
      return `<ul style="margin:0 0 1em 0;padding-left:0;list-style:none;">${renderTaskItems(node)}</ul>`;

    case "blockquote":
      return (
        `<blockquote style="margin:0 0 1em 0;padding-left:1em;` +
        `border-left:3px solid ${QUOTE_BORDER_COLOR};color:${MUTED_TEXT_COLOR};">` +
        `${(node.content ?? []).map((child) => renderBlockHtml(child)).join("")}</blockquote>`
      );

    case "horizontalRule":
      return `<hr style="border:none;border-top:1px solid ${BORDER_COLOR};margin:1em 0;" />`;

    case "codeBlock":
      return (
        `<pre style="margin:0 0 1em 0;padding:0.75em;background-color:#f4f4f4;` +
        `border:1px solid ${BORDER_COLOR};border-radius:4px;font-family:ui-monospace,monospace;` +
        `font-size:13px;white-space:pre-wrap;">${escapeHtml(collectText(node.content))}</pre>`
      );

    case "image": {
      // An inline (pasted) image's `src` is the composer's own preview URL
      // (the Blob Store's download route) — outgoing mail must reference it
      // as `cid:` instead, which is what `contentId` (#48) carries whenever
      // this node points at an inline attachment rather than a plain URL.
      const contentId = typeof node.attrs?.contentId === "string" ? node.attrs.contentId : null;
      const src = contentId
        ? `cid:${contentId}`
        : typeof node.attrs?.src === "string"
          ? node.attrs.src
          : "";
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      if (!src) return "";
      return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}" style="max-width:100%;height:auto;" />`;
    }

    case "table":
      return (
        `<table style="border-collapse:collapse;width:100%;margin:0 0 1em 0;">` +
        `${(node.content ?? []).map((row) => renderBlockHtml(row)).join("")}</table>`
      );

    // The opaque Quoted Original (#47, ADR-0013): `attrs.html` is the
    // sanitized original body exactly as it arrived — emitted **verbatim**,
    // never escaped or reformatted, which is what "byte-identical unless the
    // escape is used" means. `escapeHtml`'s `<br />` rewrite and every other
    // block case above only ever touch *authored* content; this is the one
    // case in this file that intentionally never runs it.
    case "mailQuote": {
      const html = typeof node.attrs?.html === "string" ? node.attrs.html : "";
      return (
        `<blockquote style="margin:0 0 1em 0;padding-left:1em;` +
        `border-left:3px solid ${QUOTE_BORDER_COLOR};">${html}</blockquote>`
      );
    }

    case "tableRow":
      return `<tr>${(node.content ?? []).map((cell) => renderBlockHtml(cell)).join("")}</tr>`;

    case "tableCell":
      return (
        `<td style="border:1px solid ${BORDER_COLOR};padding:6px 8px;text-align:left;">` +
        `${(node.content ?? []).map((child) => renderBlockHtml(child)).join("")}</td>`
      );

    case "tableHeader":
      return (
        `<th style="border:1px solid ${BORDER_COLOR};padding:6px 8px;text-align:left;` +
        `background-color:#f4f4f4;font-weight:600;">` +
        `${(node.content ?? []).map((child) => renderBlockHtml(child)).join("")}</th>`
      );

    default:
      // Unsupported/unknown construct: recurse into whatever content it
      // carries so at least the authored text survives, formatting lost.
      return (node.content ?? []).map((child) => renderBlockHtml(child)).join("");
  }
}

function renderListItems(node: ComposeNode): string {
  return (node.content ?? [])
    .map(
      (item) =>
        `<li style="margin:0 0 0.3em 0;">${(item.content ?? []).map((child) => renderBlockHtml(child)).join("")}</li>`,
    )
    .join("");
}

/** Task lists render as literal `☐`/`☑` text (compose-spec) — never `<input type="checkbox">`. */
function renderTaskItems(node: ComposeNode): string {
  return (node.content ?? [])
    .map((item) => {
      const checked = item.attrs?.checked === true;
      const mark = checked ? "☑" : "☐";
      const style = checked ? `text-decoration:line-through;color:${MUTED_TEXT_COLOR};` : "";
      return (
        `<li style="margin:0 0 0.3em 0;"><span style="${style}">${mark} ` +
        `${(item.content ?? []).map((child) => renderBlockHtml(child)).join("")}</span></li>`
      );
    })
    .join("");
}

function renderInlineHtml(content: ComposeNode[] | undefined): string {
  if (!content) return "";
  return content.map((node) => renderInlineNodeHtml(node)).join("");
}

function renderInlineNodeHtml(node: ComposeNode): string {
  if (node.type === "hardBreak") return "<br />";
  if (node.type !== "text" || node.text === undefined) return "";

  let html = escapeHtml(node.text);
  // Applied in a fixed order regardless of the marks array's own order, so
  // the same content always serialises to the same markup (what makes the
  // debounced push's content-hash skip meaningful).
  for (const mark of sortMarks(node.marks)) {
    html = wrapMark(html, mark);
  }
  return html;
}

const MARK_ORDER = [
  "code",
  "bold",
  "italic",
  "underline",
  "strike",
  "textStyle",
  "highlight",
  "link",
];

function sortMarks(marks: ComposeMark[] | undefined): ComposeMark[] {
  if (!marks || marks.length === 0) return [];
  return [...marks].sort(
    (left, right) => MARK_ORDER.indexOf(left.type) - MARK_ORDER.indexOf(right.type),
  );
}

function wrapMark(html: string, mark: ComposeMark): string {
  switch (mark.type) {
    case "bold":
      return `<strong>${html}</strong>`;
    case "italic":
      return `<em>${html}</em>`;
    case "underline":
      return `<u>${html}</u>`;
    case "strike":
      return `<s>${html}</s>`;
    case "code":
      return (
        `<code style="font-family:ui-monospace,monospace;font-size:0.9em;` +
        `background-color:#f4f4f4;padding:0.1em 0.3em;border-radius:3px;">${html}</code>`
      );
    case "textStyle": {
      const color = typeof mark.attrs?.color === "string" ? mark.attrs.color : null;
      return color ? `<span style="color:${escapeAttribute(color)};">${html}</span>` : html;
    }
    case "highlight": {
      const color = typeof mark.attrs?.color === "string" ? mark.attrs.color : null;
      return color
        ? `<span style="background-color:${escapeAttribute(color)};">${html}</span>`
        : html;
    }
    case "link": {
      const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : null;
      if (!href) return html;
      return `<a href="${escapeAttribute(href)}" style="color:${LINK_COLOR};text-decoration:underline;">${html}</a>`;
    }
    default:
      return html;
  }
}

// ---------------------------------------------------------------------------
// Plaintext alternative
// ---------------------------------------------------------------------------

/**
 * The document-model half of the hybrid plaintext serialisation
 * (ADR-0013). No hard wrapping, no `format=flowed` — one line per
 * paragraph, reflowed by the receiving client. Emphasis marks are dropped
 * outright; only a link's `text <url>` shape survives.
 *
 * The opaque quote subtree's `html-to-text` half (ADR-0013) has no node
 * type to walk yet — the `mailQuote` node is #47's (Reply, forward,
 * threading headers & signature), which is what actually introduces it.
 */
export function serializeComposePlaintext(doc: ComposeDocument): string {
  return doc.content
    .map((node) => renderBlockPlain(node))
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function renderBlockPlain(node: ComposeNode): string {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return renderInlinePlain(node.content);

    case "bulletList":
      return (node.content ?? [])
        .map((item) => prefixLines(renderListItemPlain(item), "- ", "  "))
        .join("\n");

    case "orderedList":
      return (node.content ?? [])
        .map((item, index) => {
          const marker = `${index + 1}. `;
          return prefixLines(renderListItemPlain(item), marker, " ".repeat(marker.length));
        })
        .join("\n");

    case "taskList":
      return (node.content ?? [])
        .map((item) => {
          const marker = item.attrs?.checked === true ? "[x] " : "[ ] ";
          return prefixLines(renderListItemPlain(item), marker, "    ");
        })
        .join("\n");

    case "blockquote":
      return (node.content ?? [])
        .map((child) => renderBlockPlain(child))
        .filter((block) => block.length > 0)
        .map((block) => prefixLines(block, "> ", "> "))
        .join("\n>\n");

    case "horizontalRule":
      return "---";

    case "codeBlock":
      return prefixLines(collectText(node.content), "    ", "    ");

    case "image": {
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      return alt ? `[image: ${alt}]` : "[image]";
    }

    case "table":
      return renderTablePlain(node);

    // The hybrid plaintext's own opaque-quote half (ADR-0013): `html-to-text`
    // over the same verbatim `attrs.html` the HTML serialiser emits, then
    // `> `-prefixed line by line — the mirror of `mailQuote`'s HTML case
    // above, at the depth this node sits at (nesting a reply-to-a-reply's
    // quote inside a quote is `blockquote`'s job, not this one's).
    case "mailQuote": {
      const html = typeof node.attrs?.html === "string" ? node.attrs.html : "";
      if (!html) return "";
      const text = htmlToText(html, { wordwrap: false });
      return prefixLines(text, "> ", "> ");
    }

    // The signature node (#47, compose-spec §Signature): preceded by the
    // RFC 3676 `-- ` sigdash, its own line — what lets a receiving client
    // that honours the convention offer to strip it on reply/forward.
    case "mailSignature": {
      const body = (node.content ?? [])
        .map((child) => renderBlockPlain(child))
        .filter((block) => block.length > 0)
        .join("\n");
      return body.length > 0 ? `-- \n${body}` : "-- ";
    }

    default:
      return (node.content ?? [])
        .map((child) => renderBlockPlain(child))
        .filter((block) => block.length > 0)
        .join("\n\n");
  }
}

function renderListItemPlain(item: ComposeNode): string {
  return (item.content ?? [])
    .map((child) => renderBlockPlain(child))
    .filter((block) => block.length > 0)
    .join("\n");
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, index) => `${index === 0 ? first : rest}${line}`)
    .join("\n");
}

function renderTablePlain(node: ComposeNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((child) => renderBlockPlain(child))
        .join(" ")
        .replace(/\n/g, " "),
    ),
  );
  return rows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

function renderInlinePlain(content: ComposeNode[] | undefined): string {
  if (!content) return "";
  return content.map((node) => renderInlineNodePlain(node)).join("");
}

function renderInlineNodePlain(node: ComposeNode): string {
  if (node.type === "hardBreak") return "\n";
  if (node.type !== "text" || node.text === undefined) return "";

  // Emphasis is dropped (compose-spec) — the only mark that survives into
  // plaintext is a link, as `text <url>`.
  const link = node.marks?.find((mark) => mark.type === "link");
  const href = link && typeof link.attrs?.href === "string" ? link.attrs.href : null;
  return href ? `${node.text} <${href}>` : node.text;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function collectText(content: ComposeNode[] | undefined): string {
  if (!content) return "";
  return content
    .map((node) => {
      if (node.type === "text") return node.text ?? "";
      if (node.type === "hardBreak") return "\n";
      return collectText(node.content);
    })
    .join("");
}

function clampHeadingLevel(level: unknown): 1 | 2 | 3 {
  const n = typeof level === "number" ? level : 1;
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br />");
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
