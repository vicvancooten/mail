import { describe, expect, it } from "vitest";
import { sanitizeCss, sanitizeMessageHtml } from "./sanitize.js";

/**
 * The ingest half of `docs/research/0005`'s two-pass pipeline. These cases
 * are the acceptance box "sanitizer strips scripts/dangerous markup at
 * ingest" spelled out — nothing here checks rendering, which is the Client's
 * second pass and its own ticket.
 */
describe("sanitizeMessageHtml", () => {
  it("discards executable and embedding tags along with their contents", () => {
    const clean = sanitizeMessageHtml(
      `<p>hello</p><script>steal(document.cookie)</script>` +
        `<iframe src="https://evil.example"></iframe>` +
        `<object data="x.swf"></object><embed src="x.swf">` +
        `<form action="https://evil.example"><input name="password"></form>`,
    );

    expect(clean).toContain("<p>hello</p>");
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("steal");
    expect(clean).not.toContain("iframe");
    expect(clean).not.toContain("object");
    expect(clean).not.toContain("embed");
    expect(clean).not.toContain("form");
    expect(clean).not.toContain("password");
  });

  it("strips every event handler attribute", () => {
    const clean = sanitizeMessageHtml(
      `<img src="https://a.example/x.png" onerror="alert(1)">` +
        `<div onclick="alert(2)" onmouseover="alert(3)">text</div>`,
    );

    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("onmouseover");
    expect(clean).not.toContain("alert");
    expect(clean).toContain('src="https://a.example/x.png"');
  });

  it("keeps only the schemes research/0005 allows, leaving the link text intact", () => {
    const clean = sanitizeMessageHtml(
      `<a href="javascript:alert(1)">js</a>` +
        `<a href="data:text/html,<script>alert(1)</script>">data</a>` +
        `<a href="http://plain.example">http</a>` +
        `<a href="https://ok.example">https</a>` +
        `<a href="mailto:vic@example.test">mail</a>`,
    );

    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("data:text/html");
    expect(clean).not.toContain("http://plain.example");
    expect(clean).toContain('href="https://ok.example"');
    expect(clean).toContain('href="mailto:vic@example.test"');
    // Dropping an href never drops what the sender wrote.
    expect(clean).toContain("js");
    expect(clean).toContain("http");
  });

  it("marks surviving links so the sender's page can never reach the opener", () => {
    const clean = sanitizeMessageHtml(`<a href="https://ok.example">go</a>`);

    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer nofollow"');
  });

  it("keeps a protocol-relative src out, since the sandboxed origin is opaque", () => {
    expect(sanitizeMessageHtml(`<img src="//evil.example/x.png">`)).not.toContain("evil.example");
  });

  it("keeps `cid:` references so inline images still resolve at render", () => {
    expect(sanitizeMessageHtml(`<img src="cid:logo@example">`)).toContain("cid:logo@example");
  });

  it("keeps styling but defuses what CSS can fetch or execute", () => {
    const clean = sanitizeMessageHtml(
      `<style>@import url("https://evil.example/x.css"); .a > .b { color: red }</style>` +
        `<div style="color:blue;background:url(http://evil.example/beacon.gif)">styled</div>`,
    );

    expect(clean).toContain("color: red");
    // The child combinator survives — `<style>` bodies are not HTML-escaped.
    expect(clean).toContain(".a > .b");
    expect(clean).not.toContain("@import");
    expect(clean).toContain("color:blue");
    expect(clean).not.toContain("beacon.gif");
    expect(clean).toContain("url(about:blank)");
  });

  it("returns an empty string rather than null for an absent body", () => {
    expect(sanitizeMessageHtml(null)).toBe("");
    expect(sanitizeMessageHtml("")).toBe("");
  });
});

describe("sanitizeCss", () => {
  it("removes the scripting-adjacent legacy properties", () => {
    const clean = sanitizeCss(
      "width:expression(alert(1)); behavior:url(x.htc); -moz-binding:url(y.xml); color:red",
    );

    expect(clean).not.toContain("expression(");
    expect(clean).not.toContain("behavior:");
    expect(clean).not.toContain("-moz-binding");
    expect(clean).toContain("color:red");
  });

  it("strips comments, which are where the rest of a payload hides", () => {
    expect(sanitizeCss("color:/*hidden*/red")).toBe("color: red");
  });

  it("refuses a style blob large enough to be a payload rather than styling", () => {
    expect(sanitizeCss(`a{color:red}`.repeat(20_000))).toBe("");
  });
});
