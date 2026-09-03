import { describe, expect, it } from "vitest";
import { plainTextToHtml } from "./bodies.js";

describe("plainTextToHtml", () => {
  // The reading pane (`MessageBody.tsx`) only ever renders `bodyHtml`; a
  // plain-text-only message (no `text/html` part) has to get one derived
  // here or it opens to a blank pane — this is that derivation's own unit
  // coverage, since `fetchMessageBody` itself needs a live IMAP connection
  // and is only exercised end to end by the GreenMail-backed suites.
  it("escapes markup and entities", () => {
    expect(plainTextToHtml("<script>alert(1)</script> & co")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; co",
    );
  });

  it("turns newlines into <br />", () => {
    expect(plainTextToHtml("line one\nline two")).toBe("line one<br />line two");
  });
});
