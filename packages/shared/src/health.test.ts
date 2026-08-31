import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./health.js";

describe("healthResponseSchema", () => {
  it("accepts a well-formed health response", () => {
    const result = healthResponseSchema.safeParse({ status: "ok", version: "0.0.0" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const result = healthResponseSchema.safeParse({ status: "degraded", version: "0.0.0" });
    expect(result.success).toBe(false);
  });
});
