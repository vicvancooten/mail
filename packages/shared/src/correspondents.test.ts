import { describe, expect, it } from "vitest";
import { correspondentId, normalizeCorrespondentAddress } from "./correspondents.js";

describe("normalizeCorrespondentAddress", () => {
  it("lowercases and trims", () => {
    expect(normalizeCorrespondentAddress("  Vic@Example.com ")).toBe("vic@example.com");
  });

  it("leaves an already-normalized address untouched", () => {
    expect(normalizeCorrespondentAddress("vic@example.com")).toBe("vic@example.com");
  });
});

describe("correspondentId", () => {
  it("is deterministic for the same (mailAccountId, address) pair", () => {
    expect(correspondentId("acct-1", "vic@example.com")).toBe(
      correspondentId("acct-1", "vic@example.com"),
    );
  });

  it("is case- and whitespace-insensitive on the address", () => {
    expect(correspondentId("acct-1", "Vic@Example.com")).toBe(
      correspondentId("acct-1", " vic@example.com "),
    );
  });

  it("scopes the same address to different Mail Accounts differently", () => {
    expect(correspondentId("acct-1", "vic@example.com")).not.toBe(
      correspondentId("acct-2", "vic@example.com"),
    );
  });
});
