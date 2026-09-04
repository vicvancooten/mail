import { describe, expect, it } from "vitest";
import { isSecureContext } from "./instance-info.js";

describe("isSecureContext", () => {
  it("returns true for https URLs", () => {
    expect(isSecureContext("https://mail.example.com")).toBe(true);
  });

  it("returns true for localhost URLs", () => {
    expect(isSecureContext("http://localhost:3000")).toBe(true);
  });

  it("returns false for invalid URLs", () => {
    expect(isSecureContext("not-a-url")).toBe(false);
  });
});
