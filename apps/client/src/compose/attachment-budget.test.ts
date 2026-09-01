import { describe, expect, it } from "vitest";
import { budgetExceededMessage, checkAttachmentBudget } from "./attachment-budget.js";

/**
 * The live budget check (compose-spec: "enforced live at selection ...
 * showing the math"). Pure, so both the drop handler and the paste handler
 * are provably checking the same thing.
 */

describe("checkAttachmentBudget", () => {
  const BUDGET = 1000; // encoded bytes

  it("is ok when nothing is attached and the new file fits", () => {
    expect(checkAttachmentBudget([], [{ size: 300 }], BUDGET)).toEqual({ kind: "ok" });
  });

  it("rejects a single file whose encoded size alone exceeds the budget", () => {
    // 900 raw bytes encodes to 1200 (base64 4/3) — over a 1000-byte budget.
    const verdict = checkAttachmentBudget([], [{ size: 900 }], BUDGET);
    expect(verdict.kind).toBe("over_budget");
  });

  it("counts already-attached files against a new selection", () => {
    // 600 raw already attached encodes to 800; 200 more raw encodes to 268 — over the remaining 200.
    const verdict = checkAttachmentBudget([{ sizeBytes: 600 }], [{ size: 200 }], BUDGET);
    expect(verdict).toMatchObject({ kind: "over_budget", remainingBytes: 200 });
  });

  it("sums every file in a multi-file drop against the same budget", () => {
    // Three ~250-byte files encode to ~1336 total — over a 1000-byte budget together, though none alone is.
    const verdict = checkAttachmentBudget(
      [],
      [{ size: 250 }, { size: 250 }, { size: 250 }],
      BUDGET,
    );
    expect(verdict.kind).toBe("over_budget");
  });

  it("shows the remaining-space message, not a bare 'too big' (compose-spec)", () => {
    const verdict = checkAttachmentBudget([{ sizeBytes: 600 }], [{ size: 200 }], BUDGET);
    if (verdict.kind !== "over_budget") throw new Error("expected over_budget");
    expect(verdict.message).toContain("MB");
    expect(verdict.message.toLowerCase()).not.toBe("too big");
  });
});

describe("budgetExceededMessage", () => {
  it("names what was added, what's left, and the limit", () => {
    const message = budgetExceededMessage(30 * 1024 * 1024, 2 * 1024 * 1024, 25 * 1024 * 1024);
    expect(message).toContain("30.0MB");
    expect(message).toContain("2.0MB");
    expect(message).toContain("25.0MB");
  });
});
