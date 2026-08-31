import { describe, expect, it } from "vitest";
import { claimRequestSchema, loginRequestSchema, usernameSchema } from "./auth.js";

describe("usernameSchema", () => {
  it("accepts a plain username", () => {
    expect(usernameSchema.safeParse("vic").success).toBe(true);
  });

  it("rejects usernames with spaces or symbols", () => {
    expect(usernameSchema.safeParse("vic van cooten").success).toBe(false);
  });

  it("rejects usernames shorter than 3 characters", () => {
    expect(usernameSchema.safeParse("vi").success).toBe(false);
  });
});

describe("claimRequestSchema", () => {
  it("requires a password of at least 8 characters", () => {
    const result = claimRequestSchema.safeParse({
      token: "abc",
      username: "vic",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed claim", () => {
    const result = claimRequestSchema.safeParse({
      token: "abc",
      username: "vic",
      password: "a-long-enough-password",
    });
    expect(result.success).toBe(true);
  });
});

describe("loginRequestSchema", () => {
  it("does not enforce password strength, only presence", () => {
    const result = loginRequestSchema.safeParse({ username: "vic", password: "x" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty password", () => {
    const result = loginRequestSchema.safeParse({ username: "vic", password: "" });
    expect(result.success).toBe(false);
  });
});
