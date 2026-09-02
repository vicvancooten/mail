import { describe, expect, it } from "vitest";
import {
  isValidLabelName,
  LABEL_NAME_MAX_LENGTH,
  labelId,
  labelNameFromId,
  normalizeLabelName,
} from "./labels.js";

describe("normalizeLabelName", () => {
  it("trims leading/trailing whitespace and collapses internal runs", () => {
    expect(normalizeLabelName("  Work   Stuff  ")).toBe("Work Stuff");
  });

  it("leaves an already-clean name untouched", () => {
    expect(normalizeLabelName("Work")).toBe("Work");
  });
});

describe("isValidLabelName", () => {
  it("rejects empty and whitespace-only names", () => {
    expect(isValidLabelName("")).toBe(false);
    expect(isValidLabelName("   ")).toBe(false);
  });

  it("accepts an ordinary name", () => {
    expect(isValidLabelName("Work")).toBe(true);
  });

  it("rejects a name past the length cap, accepts one at it", () => {
    expect(isValidLabelName("a".repeat(LABEL_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidLabelName("a".repeat(LABEL_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("labelId", () => {
  it("is deterministic for the same (mailAccountId, name) pair", () => {
    expect(labelId("acct-1", "Work")).toBe(labelId("acct-1", "Work"));
  });

  it("normalizes the name before deriving the id", () => {
    expect(labelId("acct-1", "  Work  ")).toBe(labelId("acct-1", "Work"));
  });

  it("scopes the id to its Mail Account — the same name differs across accounts", () => {
    expect(labelId("acct-1", "Work")).not.toBe(labelId("acct-2", "Work"));
  });
});

describe("labelNameFromId", () => {
  it("inverts labelId for the same Mail Account", () => {
    const id = labelId("acct-1", "Work");
    expect(labelNameFromId("acct-1", id)).toBe("Work");
  });

  it("falls back to the id verbatim when the account prefix doesn't match", () => {
    const id = labelId("acct-1", "Work");
    expect(labelNameFromId("acct-2", id)).toBe(id);
  });
});
