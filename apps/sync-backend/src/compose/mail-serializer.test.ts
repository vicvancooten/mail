import type { ComposeDocument } from "@mail/shared";
import { describe, expect, it } from "vitest";
import { serializeComposeHtml, serializeComposePlaintext } from "./mail-serializer.js";

function text(value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

describe("serializeComposeHtml", () => {
  it("wraps the body in an explicit color and background-color, never inheriting", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [{ type: "paragraph", content: [text("hi")] }],
    };
    const html = serializeComposeHtml(doc);
    expect(html).toMatch(/^<div style="color:[^;]+;background-color:[^;]+;/);
  });

  it("uses inline styles only — no <style> block, no classes, no custom properties, no flex/grid", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [text("Title")] },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [text("Col")] }] },
              ],
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [text("item")] }] },
          ],
        },
      ],
    };
    const html = serializeComposeHtml(doc);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/class="/);
    expect(html).not.toMatch(/--[a-z-]+:/); // no CSS custom properties
    expect(html).not.toMatch(/display:\s*flex/);
    expect(html).not.toMatch(/display:\s*grid/);
  });

  it("renders a task list as ☐/☑ text, never <input type=checkbox>", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [text("done")] }],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [{ type: "paragraph", content: [text("todo")] }],
            },
          ],
        },
      ],
    };
    const html = serializeComposeHtml(doc);
    expect(html).not.toContain("<input");
    expect(html).toContain("☑");
    expect(html).toContain("☐");
  });

  it("renders a table as a real <table> with inline border/padding and width:100%", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [text("A")] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [text("B")] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [text("1")] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [text("2")] }] },
              ],
            },
          ],
        },
      ],
    };
    const html = serializeComposeHtml(doc);
    expect(html).toContain("<table");
    expect(html).toContain("border-collapse:collapse");
    expect(html).toContain("width:100%");
    expect(html).toMatch(/<td style="[^"]*border:1px solid/);
  });

  it("renders an image with max-width:100% and height:auto", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "cid:abc", alt: "a cat" } }],
    };
    const html = serializeComposeHtml(doc);
    expect(html).toContain('src="cid:abc"');
    expect(html).toContain("max-width:100%");
    expect(html).toContain("height:auto");
  });

  it("rewrites an inline (pasted) image's preview URL to cid: at MIME-build time (#48)", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "/compositions/comp-1/attachments/att-1",
            contentId: "att-1@mail.local",
            alt: "a screenshot",
          },
        },
      ],
    };
    const html = serializeComposeHtml(doc);
    expect(html).toContain('src="cid:att-1@mail.local"');
    expect(html).not.toContain("/compositions/comp-1/attachments/att-1");
  });

  it("escapes text content", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [{ type: "paragraph", content: [text("<script>alert(1)</script>")] }],
    };
    const html = serializeComposeHtml(doc);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("degrades an unsupported node type by recursing into its content", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        { type: "someFutureNode", content: [{ type: "paragraph", content: [text("still here")] }] },
      ],
    };
    const html = serializeComposeHtml(doc);
    expect(html).toContain("still here");
  });

  it("applies marks in a fixed, content-independent order", () => {
    const a: ComposeDocument = {
      type: "doc",
      content: [
        { type: "paragraph", content: [text("x", [{ type: "italic" }, { type: "bold" }])] },
      ],
    };
    const b: ComposeDocument = {
      type: "doc",
      content: [
        { type: "paragraph", content: [text("x", [{ type: "bold" }, { type: "italic" }])] },
      ],
    };
    expect(serializeComposeHtml(a)).toBe(serializeComposeHtml(b));
  });
});

describe("serializeComposePlaintext", () => {
  it("drops emphasis marks rather than rendering markdown", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [{ type: "paragraph", content: [text("bold text", [{ type: "bold" }])] }],
    };
    expect(serializeComposePlaintext(doc)).toBe("bold text");
  });

  it("renders a link as `text <url>`", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            text("click here", [{ type: "link", attrs: { href: "https://example.test" } }]),
          ],
        },
      ],
    };
    expect(serializeComposePlaintext(doc)).toBe("click here <https://example.test>");
  });

  it("renders bullet and ordered lists with - and 1. markers", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [text("first")] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [text("second")] }] },
          ],
        },
        {
          type: "orderedList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("one")] }] }],
        },
      ],
    };
    const out = serializeComposePlaintext(doc);
    expect(out).toContain("- first");
    expect(out).toContain("- second");
    expect(out).toContain("1. one");
  });

  it("prefixes a blockquote with '> '", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        { type: "blockquote", content: [{ type: "paragraph", content: [text("quoted")] }] },
      ],
    };
    expect(serializeComposePlaintext(doc)).toBe("> quoted");
  });

  it("renders a heading as a bare text line, no markdown #", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 2 }, content: [text("Section")] }],
    };
    expect(serializeComposePlaintext(doc)).toBe("Section");
  });

  it("has no hard wrapping — one line per paragraph regardless of length", () => {
    const long = "word ".repeat(40).trim();
    const doc: ComposeDocument = {
      type: "doc",
      content: [{ type: "paragraph", content: [text(long)] }],
    };
    expect(serializeComposePlaintext(doc)).toBe(long);
    expect(serializeComposePlaintext(doc)).not.toContain("\n");
  });

  it("renders a table as pipe-delimited rows", () => {
    const doc: ComposeDocument = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [text("A")] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [text("B")] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(serializeComposePlaintext(doc)).toBe("| A | B |");
  });
});
