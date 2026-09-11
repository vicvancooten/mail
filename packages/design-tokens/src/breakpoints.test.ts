import { describe, expect, it } from "vitest";
import { phoneBreakpoint } from "./breakpoints.js";

describe("phoneBreakpoint", () => {
  it("is 768 (#270's own phone-chrome value, #273's one breakpoint)", () => {
    expect(phoneBreakpoint).toBe(768);
  });
});
