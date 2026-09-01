import { describe, expect, it } from "vitest";
import { generateUlid } from "./ulid.js";

describe("generateUlid", () => {
  it("produces a 26-character Crockford Base32 string", () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is unique across many calls at the same instant", () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 200 }, () => generateUlid(now)));
    expect(ids.size).toBe(200);
  });

  it("is monotonic across calls sharing a millisecond — call order is sort order", () => {
    const now = Date.now();
    const ids = Array.from({ length: 50 }, () => generateUlid(now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("sorts lexicographically by creation time", () => {
    const earlier = generateUlid(1_000);
    const later = generateUlid(2_000);
    expect(earlier < later).toBe(true);
  });

  it("has a stable-length timestamp prefix that grows with time", () => {
    // The first 10 characters are the timestamp; two ids a millisecond
    // apart differ only there, never in length.
    const a = generateUlid(1_700_000_000_000);
    const b = generateUlid(1_700_000_000_001);
    expect(a.slice(0, 10)).not.toEqual(b.slice(0, 10));
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});
