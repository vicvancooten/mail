import { describe, expect, it } from "vitest";
import { providerAvailabilitySchema } from "./providers.js";

describe("providerAvailabilitySchema", () => {
  it("accepts an available Provider only when unavailableReason is null", () => {
    const result = providerAvailabilitySchema.safeParse({
      provider: "google",
      available: true,
      unavailableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an available Provider with an unavailableReason", () => {
    const result = providerAvailabilitySchema.safeParse({
      provider: "google",
      available: true,
      unavailableReason: "not_registered",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unavailable Provider without an unavailableReason", () => {
    const result = providerAvailabilitySchema.safeParse({
      provider: "microsoft",
      available: false,
      unavailableReason: null,
    });
    expect(result.success).toBe(false);
  });
});
