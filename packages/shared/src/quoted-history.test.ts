import { describe, expect, it } from "vitest";
import {
  splitMessageQuotedHistory,
  splitPlainTextMessageHtml,
  splitQuotedHtml,
  stripQuotedHistory,
} from "./quoted-history.js";

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

describe("splitQuotedHtml", () => {
  it("splits at the first blockquote, keeping it (and everything after it) as quoted", () => {
    const html = "<div>Agreed.</div><blockquote><p>Earlier thing</p></blockquote><p>tail</p>";
    const split = splitQuotedHtml(html);
    expect(split.visible).toBe("<div>Agreed.</div>");
    expect(split.quoted).toBe("<blockquote><p>Earlier thing</p></blockquote><p>tail</p>");
  });

  it("splits at a vendor quote container with no blockquote wrapper", () => {
    const html = '<div>Short answer: yes.</div><div class="gmail_quote">On Mon, Alice wrote:</div>';
    const split = splitQuotedHtml(html);
    expect(split.visible).toBe("<div>Short answer: yes.</div>");
    expect(split.quoted).toContain("gmail_quote");
  });

  it("returns no quoted half for a body with neither", () => {
    const html = "<p>Just a note.</p>";
    expect(splitQuotedHtml(html)).toEqual({ visible: html, quoted: null });
  });
});

describe("splitPlainTextMessageHtml", () => {
  it("splits the plainTextToHtml-synthesized markup at the same line the text would cut at", () => {
    const text = ["Sounds good.", "", "> Are we still on?"].join("\n");
    const html = "Sounds good.<br /><br />&gt; Are we still on?";
    const split = splitPlainTextMessageHtml(text, html);
    expect(split.visible).toBe("Sounds good.<br />");
    expect(split.quoted).toBe("&gt; Are we still on?");
  });

  it("returns no quoted half when the text has no history", () => {
    const text = "Just a note.";
    const html = "Just a note.";
    expect(splitPlainTextMessageHtml(text, html)).toEqual({ visible: html, quoted: null });
  });

  it("returns no quoted half when there is no text to find the cut line in", () => {
    const html = "<p>hi</p>";
    expect(splitPlainTextMessageHtml("", html)).toEqual({ visible: html, quoted: null });
  });
});

describe("splitMessageQuotedHistory", () => {
  it("uses the HTML rule for a native-HTML message", () => {
    const split = splitMessageQuotedHistory({
      bodyHtml: "<div>Agreed.</div><blockquote>Earlier</blockquote>",
      bodyText: "Agreed.\n\n> Earlier",
      bodyIsPlainText: false,
    });
    expect(split.visible).toBe("<div>Agreed.</div>");
    expect(split.quoted).toBe("<blockquote>Earlier</blockquote>");
  });

  it("uses the plain-text rule for a message with no native HTML", () => {
    const split = splitMessageQuotedHistory({
      bodyHtml: "Agreed.<br /><br />&gt; Earlier",
      bodyText: "Agreed.\n\n> Earlier",
      bodyIsPlainText: true,
    });
    expect(split.visible).toBe("Agreed.<br />");
    expect(split.quoted).toBe("&gt; Earlier");
  });

  it("returns an empty, unquoted split for a message with no body at all", () => {
    expect(
      splitMessageQuotedHistory({ bodyHtml: null, bodyText: null, bodyIsPlainText: false }),
    ).toEqual({
      visible: "",
      quoted: null,
    });
  });
});
