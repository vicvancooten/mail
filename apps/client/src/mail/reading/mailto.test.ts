import { describe, expect, it } from "vitest";
import { parseMailtoHref } from "./mailto.js";

describe("parseMailtoHref", () => {
  it("returns null for a non-mailto href", () => {
    expect(parseMailtoHref("https://example.com")).toBeNull();
  });

  it("returns null for a malformed mailto: href", () => {
    expect(parseMailtoHref("mailto:")).not.toBeNull(); // empty address list is fine, still a URL
    expect(parseMailtoHref("mailto:%")).toBeNull();
  });

  it("extracts a single recipient", () => {
    expect(parseMailtoHref("mailto:jane@example.com")).toEqual({
      to: [{ address: "jane@example.com", name: null }],
      subject: null,
      body: null,
    });
  });

  it("extracts multiple comma-separated recipients", () => {
    expect(parseMailtoHref("mailto:a@example.com,b@example.com")?.to).toEqual([
      { address: "a@example.com", name: null },
      { address: "b@example.com", name: null },
    ]);
  });

  it("reads subject and body from the query string", () => {
    const link = parseMailtoHref("mailto:jane@example.com?subject=Hi%20there&body=See%20you");
    expect(link?.subject).toBe("Hi there");
    expect(link?.body).toBe("See you");
  });

  it("is case-insensitive on the scheme", () => {
    expect(parseMailtoHref("MAILTO:jane@example.com")?.to).toEqual([
      { address: "jane@example.com", name: null },
    ]);
  });
});
