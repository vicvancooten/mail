import { describe, expect, it } from "vitest";
import { bulkTriageBatchRequestSchema, bulkTriageTargetSchema } from "./bulk-triage.js";

const VALID_TARGET = {
  accountScope: ["account-1"],
  folderRole: "inbox",
  since: "2026-01-01T00:00:00.000Z",
  until: "2026-01-02T00:00:00.000Z",
};

describe("bulkTriageTargetSchema", () => {
  it("accepts a well-formed target", () => {
    expect(bulkTriageTargetSchema.safeParse(VALID_TARGET).success).toBe(true);
  });

  it("accepts a null since (everything older) and a null until (up to now)", () => {
    expect(bulkTriageTargetSchema.safeParse({ ...VALID_TARGET, since: null }).success).toBe(true);
    expect(bulkTriageTargetSchema.safeParse({ ...VALID_TARGET, until: null }).success).toBe(true);
  });

  it("rejects an empty accountScope — a batch always names at least one Mail Account", () => {
    const result = bulkTriageTargetSchema.safeParse({ ...VALID_TARGET, accountScope: [] });
    expect(result.success).toBe(false);
  });

  it("rejects since at or after until", () => {
    const result = bulkTriageTargetSchema.safeParse({
      ...VALID_TARGET,
      since: VALID_TARGET.until,
      until: VALID_TARGET.until,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized folder role", () => {
    const result = bulkTriageTargetSchema.safeParse({ ...VALID_TARGET, folderRole: "snoozed" });
    expect(result.success).toBe(false);
  });
});

describe("bulkTriageBatchRequestSchema", () => {
  it("accepts a done batch and a markRead batch", () => {
    expect(
      bulkTriageBatchRequestSchema.safeParse({ id: "01A", action: "done", target: VALID_TARGET })
        .success,
    ).toBe(true);
    expect(
      bulkTriageBatchRequestSchema.safeParse({
        id: "01B",
        action: "markRead",
        target: VALID_TARGET,
      }).success,
    ).toBe(true);
  });

  it("rejects an unrecognized action", () => {
    const result = bulkTriageBatchRequestSchema.safeParse({
      id: "01A",
      action: "delete",
      target: VALID_TARGET,
    });
    expect(result.success).toBe(false);
  });
});
