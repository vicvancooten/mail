import { describe, expect, it } from "vitest";
import { providerAvailabilitySchema, startProviderSignInRequestSchema } from "./providers.js";

describe("providerAvailabilitySchema", () => {
  it("accepts an available Provider only when unavailableReason is null", () => {
    const result = providerAvailabilitySchema.safeParse({
      provider: "google",
      available: true,
      unavailableReason: null,
      // #202: the per-Facet fields the `available: true` branch requires.
      calendarApiEnabled: false,
      contactsApiEnabled: false,
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

describe("startProviderSignInRequestSchema (#202)", () => {
  it("accepts an empty body — add_mail_account", () => {
    expect(startProviderSignInRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts mailAccountId alone — reauth", () => {
    expect(startProviderSignInRequestSchema.safeParse({ mailAccountId: "acct-1" }).success).toBe(
      true,
    );
  });

  it("accepts connectedAccountId and facet together — add_facet", () => {
    expect(
      startProviderSignInRequestSchema.safeParse({
        connectedAccountId: "conn-1",
        facet: "calendar",
      }).success,
    ).toBe(true);
  });

  it("rejects connectedAccountId without a facet", () => {
    expect(
      startProviderSignInRequestSchema.safeParse({ connectedAccountId: "conn-1" }).success,
    ).toBe(false);
  });

  it("rejects a facet without connectedAccountId", () => {
    expect(startProviderSignInRequestSchema.safeParse({ facet: "calendar" }).success).toBe(false);
  });

  it("rejects mailAccountId and connectedAccountId together", () => {
    expect(
      startProviderSignInRequestSchema.safeParse({
        mailAccountId: "acct-1",
        connectedAccountId: "conn-1",
        facet: "calendar",
      }).success,
    ).toBe(false);
  });

  it("rejects mail as a facet — a Mail Facet is never granted onto an existing Connected Account", () => {
    expect(
      startProviderSignInRequestSchema.safeParse({ connectedAccountId: "conn-1", facet: "mail" })
        .success,
    ).toBe(false);
  });
});
