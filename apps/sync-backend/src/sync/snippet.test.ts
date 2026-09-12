import { describe, expect, it } from "vitest";
import { deriveSnippet, htmlToPreviewText } from "./snippet.js";

// `stripQuotedHistory`'s own tests moved to `@mail/shared` with the
// function itself (#291); `deriveSnippet`'s tests below still exercise it
// end-to-end through the Snippet.

describe("htmlToPreviewText", () => {
  it("drops blockquotes and the vendor quote containers", () => {
    const html =
      `<div>Agreed.</div><blockquote><p>Earlier thing</p></blockquote>` +
      `<div class="gmail_quote">On Mon, Alice wrote: older</div>`;
    const text = htmlToPreviewText(html);

    expect(text).toContain("Agreed.");
    expect(text).not.toContain("Earlier thing");
    expect(text).not.toContain("older");
  });

  it("decodes the entities a flattened body is full of", () => {
    expect(
      htmlToPreviewText("<p>Tom &amp; Jerry&nbsp;&mdash;&nbsp;&#8220;hi&#8221;</p>"),
    ).toContain("Tom & Jerry — “hi”");
  });
});

describe("deriveSnippet", () => {
  it("prefers the plain-text alternative", () => {
    expect(deriveSnippet({ text: "plain wins", html: "<p>html loses</p>" })).toBe("plain wins");
  });

  it("falls back to the sanitized HTML when there is no plain part", () => {
    expect(deriveSnippet({ text: null, html: "<p>Hello <b>there</b></p>" })).toBe("Hello there");
  });

  it("strips quoted history in the HTML path too", () => {
    const snippet = deriveSnippet({
      text: null,
      html: "<div>Short answer: yes.</div><blockquote>The long question</blockquote>",
    });
    expect(snippet).toBe("Short answer: yes.");
  });

  it("collapses whitespace and truncates long bodies", () => {
    const snippet = deriveSnippet({ text: `${"word ".repeat(200)}`, html: null });
    expect(snippet).not.toBeNull();
    expect(snippet?.length).toBeLessThanOrEqual(281);
    expect(snippet?.endsWith("…")).toBe(true);
    expect(snippet).not.toContain("  ");
  });

  it("returns null when there is nothing to preview", () => {
    expect(deriveSnippet({ text: null, html: null })).toBeNull();
    expect(deriveSnippet({ text: "   ", html: "<p>&nbsp;</p>" })).toBeNull();
  });
});
