import { describe, expect, it } from "vitest";
import {
  gatekeeperScopeSchema,
  gatekeeperVerdictId,
  isBarredVerdictDomain,
  normalizeGatekeeperSender,
  normalizeSenderAddress,
  senderDomain,
} from "./gatekeeper.js";

describe("normalizeSenderAddress", () => {
  it("trims and lowercases", () => {
    expect(normalizeSenderAddress("  Vic@Example.COM ")).toBe("vic@example.com");
  });

  it("keeps the plus tag — poc-spec.md is explicit that it is not stripped", () => {
    expect(normalizeSenderAddress("vic+news@example.com")).toBe("vic+news@example.com");
    expect(normalizeSenderAddress("vic+news@example.com")).not.toBe(
      normalizeSenderAddress("vic@example.com"),
    );
  });
});

describe("senderDomain", () => {
  it("takes the part after the last @", () => {
    expect(senderDomain("Vic@Example.com")).toBe("example.com");
    expect(senderDomain('"odd@name"@example.com')).toBe("example.com");
  });

  it("refuses to guess a domain out of a malformed address", () => {
    expect(senderDomain("no-at-sign")).toBeNull();
    expect(senderDomain("@example.com")).toBeNull();
    expect(senderDomain("vic@")).toBeNull();
  });
});

describe("isBarredVerdictDomain", () => {
  it("bars the consumer providers a domain verdict would be meaningless for", () => {
    expect(isBarredVerdictDomain("gmail.com")).toBe(true);
    expect(isBarredVerdictDomain("  Outlook.com ")).toBe(true);
  });

  it("allows an ordinary organisation domain", () => {
    expect(isBarredVerdictDomain("a-insights.eu")).toBe(false);
  });
});

describe("gatekeeperScopeSchema", () => {
  it("admits recipient alongside address and domain (#103's Blocked Alias)", () => {
    expect(gatekeeperScopeSchema.safeParse("recipient").success).toBe(true);
  });
});

describe("gatekeeperVerdictId", () => {
  it("scopes the id to its Mail Account so two accounts never share a verdict row", () => {
    expect(gatekeeperVerdictId("acct-1", "address", "Vic@Example.com")).toBe(
      "acct-1:address:vic@example.com",
    );
    expect(gatekeeperVerdictId("acct-2", "address", "vic@example.com")).not.toBe(
      gatekeeperVerdictId("acct-1", "address", "vic@example.com"),
    );
  });

  it("keeps address and domain scopes apart", () => {
    expect(gatekeeperVerdictId("acct-1", "domain", "example.com")).not.toBe(
      gatekeeperVerdictId("acct-1", "address", "example.com"),
    );
  });
});

describe("normalizeGatekeeperSender", () => {
  it("normalizes the value and leaves the scope alone", () => {
    expect(normalizeGatekeeperSender({ scope: "domain", value: " Example.COM " })).toEqual({
      scope: "domain",
      value: "example.com",
    });
  });
});
