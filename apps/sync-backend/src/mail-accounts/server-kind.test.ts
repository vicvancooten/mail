import { describe, expect, it } from "vitest";
import { detectServerKind } from "./server-kind.js";

/** A fake IMAP client exposing only the property `detectServerKind` reads (#121). */
function fakeClient(capabilities: string[]): Parameters<typeof detectServerKind>[0] {
  return { capabilities: new Map(capabilities.map((name) => [name, true])) };
}

describe("detectServerKind", () => {
  it("records gmail when the capability list carries X-GM-EXT-1", () => {
    expect(detectServerKind(fakeClient(["IMAP4rev1", "X-GM-EXT-1", "IDLE"]))).toBe("gmail");
  });

  it("records generic when the capability list doesn't carry X-GM-EXT-1", () => {
    expect(detectServerKind(fakeClient(["IMAP4rev1", "IDLE", "QRESYNC"]))).toBe("generic");
  });

  it("records generic for an empty capability list", () => {
    expect(detectServerKind(fakeClient([]))).toBe("generic");
  });
});
