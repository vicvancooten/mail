import { describe, expect, it } from "vitest";
import {
  phoneBreakpoint,
  splitListMinimumWidth,
  splitMinimum,
  splitReaderReadableWidth,
} from "./breakpoints.js";

describe("phoneBreakpoint", () => {
  it("is 768 (#270's own phone-chrome value, #273's one breakpoint)", () => {
    expect(phoneBreakpoint).toBe(768);
  });
});

describe("splitMinimum", () => {
  it("is 920 — the list minimum plus a readable Reader, not a picked number (#296)", () => {
    expect(splitListMinimumWidth).toBe(280);
    expect(splitReaderReadableWidth).toBe(640);
    expect(splitMinimum).toBe(splitListMinimumWidth + splitReaderReadableWidth);
    expect(splitMinimum).toBe(920);
  });
});
