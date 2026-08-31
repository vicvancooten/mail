import { describe, expect, it } from "vitest";
import { deriveSnippet, htmlToPreviewText, stripQuotedHistory } from "./snippet.js";

describe("stripQuotedHistory", () => {
  it("cuts at a `>`-quoted block", () => {
    const body = ["Sounds good to me.", "", "> Are we still on for Tuesday?", "> — A"].join("\n");
    expect(stripQuotedHistory(body).trim()).toBe("Sounds good to me.");
  });

  it("cuts at an English attribution line", () => {
    const body = [
      "Yes, that works.",
      "",
      "On Mon, 3 Mar 2025 at 09:12, Alice <alice@example.test> wrote:",
      "Are we still on?",
    ].join("\n");
    expect(stripQuotedHistory(body).trim()).toBe("Yes, that works.");
  });

  it("cuts at a Dutch attribution line", () => {
    const body = ["Prima.", "", "Op 3 maart 2025 om 09:12 schreef Alice:", "Gaat het door?"].join(
      "\n",
    );
    expect(stripQuotedHistory(body).trim()).toBe("Prima.");
  });

  it("cuts at an attribution that wrapped over two lines", () => {
    const body = [
      "Confirmed.",
      "",
      "On Mon, 3 Mar 2025 at 09:12, Alice Anderson",
      "<alice.anderson@a-very-long-domain.test> wrote:",
      "Please confirm.",
    ].join("\n");
    expect(stripQuotedHistory(body).trim()).toBe("Confirmed.");
  });

  it("cuts at Outlook's original-message banner and at its underscore rule", () => {
    expect(stripQuotedHistory("Fine.\n\n-----Original Message-----\nFrom: a").trim()).toBe("Fine.");
    expect(stripQuotedHistory("Fine.\n\n__________________\nFrom: a").trim()).toBe("Fine.");
  });

  it("cuts at a pasted header block, but only once a second header line confirms it", () => {
    const forwarded = ["FYI.", "", "From: Alice <a@example.test>", "Sent: Monday", "Hi"].join("\n");
    expect(stripQuotedHistory(forwarded).trim()).toBe("FYI.");

    // A sentence that merely starts with "From:" is the message, not a quote.
    const prose = "From: the look of it, this is fine.\nLet me know.";
    expect(stripQuotedHistory(prose)).toBe(prose);
  });

  it("cuts at the RFC 3676 signature delimiter", () => {
    expect(stripQuotedHistory("See attached.\n\n-- \nVic\nMail").trim()).toBe("See attached.");
  });

  it("leaves a message with no history untouched", () => {
    const body = "Just a note.\nNothing quoted here.";
    expect(stripQuotedHistory(body)).toBe(body);
  });
});

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
