import { describe, expect, it } from "vitest";
import {
  BLOCKED_IMAGE_PLACEHOLDER,
  buildMessageCsp,
  buildMessageDocument,
  hasProxiedImages,
  sanitizeAndSubstitute,
  senderDeclaresColorScheme,
} from "./sandbox-document.js";

/**
 * The Client's re-sanitize pass and the sandboxed document it produces
 * (#41). This is the acceptance box "Hostile HTML fixture set renders inert
 * (no script exec, no remote fetch without opt-in)" spelled out at the
 * render layer — `sync/sanitize.test.ts` (sync-backend) is the same bar at
 * ingest.
 */
describe("sanitizeAndSubstitute", () => {
  const noImages = { cidBlobUrls: new Map<string, string>(), imagesLoaded: false };

  it("discards script tags and every event handler attribute", () => {
    const out = sanitizeAndSubstitute(
      `<p>hi</p><script>steal(document.cookie)</script>` +
        `<img src="https://a.example/x.png" onerror="alert(1)">` +
        `<div onclick="alert(2)">text</div>`,
      noImages,
    );
    expect(out).toContain("<p>hi</p>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("steal");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert");
  });

  it("discards iframe/object/embed/form even though the server already should have", () => {
    const out = sanitizeAndSubstitute(
      `<iframe src="https://evil.example"></iframe>` +
        `<object data="x.swf"></object><embed src="x.swf">` +
        `<form action="https://evil.example"><input name="password"></form>`,
      noImages,
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("password");
  });

  it("strips javascript: and data:text/html hrefs, keeping the link text", () => {
    const out = sanitizeAndSubstitute(
      `<a href="javascript:alert(1)">js</a><a href="data:text/html,<script>alert(1)</script>">data</a>`,
      noImages,
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:text/html");
    expect(out).toContain("js");
    expect(out).toContain("data");
  });

  it("blocks a proxied remote image by default, replacing it with a same-document placeholder", () => {
    const out = sanitizeAndSubstitute(
      `<img src="/messages/m1/image-proxy?url=https%3A%2F%2Fsender.example%2Ft.gif&sig=abc">`,
      noImages,
    );
    expect(out).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`);
    expect(out).not.toContain("image-proxy");
  });

  it("leaves a proxied remote image alone once opted in", () => {
    const src = "/messages/m1/image-proxy?url=https%3A%2F%2Fsender.example%2Ft.gif&sig=abc";
    const out = sanitizeAndSubstitute(`<img src="${src}">`, {
      cidBlobUrls: new Map(),
      imagesLoaded: true,
    });
    // Serialized as an attribute value, `&` comes back HTML-entity-escaped
    // (`&amp;`) — that decodes back to the exact same URL when the browser
    // parses it, which is what actually matters.
    expect(out).toContain(
      'src="/messages/m1/image-proxy?url=https%3A%2F%2Fsender.example%2Ft.gif&amp;sig=abc"',
    );
  });

  it("resolves a cid: image to its blob: URL when the attachment was fetched", () => {
    const out = sanitizeAndSubstitute(`<img src="cid:logo@example">`, {
      cidBlobUrls: new Map([["logo@example", "blob:http://localhost/abc-123"]]),
      imagesLoaded: false,
    });
    expect(out).toContain('src="blob:http://localhost/abc-123"');
    expect(out).not.toContain("cid:logo@example");
  });

  it("drops the src (never leaves a cid: URL, which the browser could never fetch anyway) when unresolved", () => {
    const out = sanitizeAndSubstitute(`<img src="cid:missing@example">`, noImages);
    expect(out).not.toContain("cid:missing@example");
    expect(out).not.toContain("src=");
  });

  it("blocks a proxied background-image the same way as an <img>", () => {
    const src = "/messages/m1/image-proxy?url=https%3A%2F%2Fsender.example%2Fbg.png&sig=abc";
    const out = sanitizeAndSubstitute(`<div style="background:url(${src})">x</div>`, noImages);
    expect(out).toContain("url(about:blank)");
    expect(out).not.toContain("image-proxy");
  });

  it("resolves a cid: background-image reference in a <style> block", () => {
    const out = sanitizeAndSubstitute(`<style>.logo{background:url(cid:logo@example)}</style>`, {
      cidBlobUrls: new Map([["logo@example", "blob:http://localhost/xyz"]]),
      imagesLoaded: false,
    });
    expect(out).toContain("url(blob:http://localhost/xyz)");
  });

  it("keeps styling but strips CSS that fetches or executes (@import survives the browser step, but not this)", () => {
    const out = sanitizeAndSubstitute(
      `<div style="color:blue;width:expression(alert(1))">styled</div>`,
      noImages,
    );
    expect(out).toContain("color");
    expect(out).not.toContain("expression(");
  });
});

describe("hasProxiedImages", () => {
  it("is true only when a proxy-rewritten reference is present", () => {
    expect(hasProxiedImages(`<img src="/messages/m1/image-proxy?url=x&sig=y">`)).toBe(true);
    expect(hasProxiedImages(`<img src="cid:logo@example">`)).toBe(false);
    expect(hasProxiedImages(`<p>no images</p>`)).toBe(false);
  });
});

describe("senderDeclaresColorScheme", () => {
  it("is true when the sender's CSS declares color-scheme", () => {
    expect(senderDeclaresColorScheme(`<style>:root{color-scheme:light dark}</style>`)).toBe(true);
    expect(senderDeclaresColorScheme(`<div style="color-scheme: light only">x</div>`)).toBe(true);
  });

  it("is false for ordinary mail with no such declaration", () => {
    expect(senderDeclaresColorScheme(`<p style="color:red">hi</p>`)).toBe(false);
  });
});

describe("buildMessageCsp", () => {
  it("names the app's real origin for img-src, never 'self' — the sandboxed doc's own origin is opaque", () => {
    const csp = buildMessageCsp({ nonce: "abc123", origin: "https://mail.example.com" });
    expect(csp).toContain("img-src https://mail.example.com data: blob:");
    expect(csp).not.toContain("img-src 'self'");
    expect(csp).toContain("script-src 'nonce-abc123'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

describe("buildMessageDocument", () => {
  const baseOpts = {
    cidBlobUrls: new Map<string, string>(),
    imagesLoaded: false,
    nonce: "test-nonce",
    origin: "https://mail.example.com",
    linkBridge: true,
  };

  it("wraps sanitized content in a document carrying the CSP meta tag and the nonced resize script", () => {
    const doc = buildMessageDocument({ ...baseOpts, html: "<p>hello</p>", darkMode: false });
    expect(doc).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(doc).toContain("nonce-test-nonce");
    expect(doc).toContain('<script nonce="test-nonce">');
    expect(doc).toContain("ResizeObserver");
    expect(doc).toContain("<p>hello</p>");
  });

  it("carries the click bridge (ADR-0018) under the same nonce as the resize script", () => {
    const doc = buildMessageDocument({ ...baseOpts, html: "<p>hello</p>", darkMode: false });
    expect(doc).toContain("mail-link-click");
    expect(doc).toContain('closest("a[href]")');
  });

  it("omits the click bridge when linkBridge is false (#102: links inert, no bridge in this context)", () => {
    const doc = buildMessageDocument({
      ...baseOpts,
      linkBridge: false,
      html: '<p><a href="https://evil.example">click</a></p>',
      darkMode: false,
    });
    expect(doc).not.toContain("mail-link-click");
    expect(doc).not.toContain('closest("a[href]")');
    // The resize and image-error scripts still run — only the bridge is dropped.
    expect(doc).toContain("ResizeObserver");
    expect(doc).toContain("mail-image-error");
  });

  it("carries the image-error handler and its visible-error style", () => {
    const doc = buildMessageDocument({ ...baseOpts, html: "<p>hello</p>", darkMode: false });
    expect(doc).toContain("mail-image-error");
    expect(doc).toContain('"error"');
  });

  it("applies the double-invert wrapper only when dark mode is on and the sender hasn't opted out", () => {
    const dark = buildMessageDocument({ ...baseOpts, html: "<p>hi</p>", darkMode: true });
    expect(dark).toContain("mail-invert");
    expect(dark).toContain("invert(1) hue-rotate(180deg)");

    const light = buildMessageDocument({ ...baseOpts, html: "<p>hi</p>", darkMode: false });
    expect(light).not.toContain("mail-invert");
  });

  it("never inverts a sender that declares its own color-scheme, even in dark mode", () => {
    const doc = buildMessageDocument({
      ...baseOpts,
      html: `<style>:root{color-scheme:light dark}</style><p>hi</p>`,
      darkMode: true,
    });
    expect(doc).not.toContain("mail-invert");
  });

  it("still strips a script tag even when it's the last thing in the pipeline", () => {
    const doc = buildMessageDocument({
      ...baseOpts,
      html: `<p>hi</p><script>alert(document.cookie)</script>`,
      darkMode: false,
    });
    expect(doc).not.toContain("alert(document.cookie)");
  });
});
