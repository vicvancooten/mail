import { describe, expect, it } from "vitest";
import { validateSend } from "./send-validation.js";

/**
 * compose-spec §Send-time validation & failure: what blocks a send outright
 * and what only warns once.
 */

const BODY = { subject: "Lunch", bodyIsEmpty: false };
const ADA = { name: null, address: "ada@example.test" };

describe("validateSend", () => {
  it("blocks a send with no recipient at all", () => {
    expect(validateSend({ ...BODY, to: [], cc: [], bcc: [] })).toEqual({
      kind: "blocked",
      reason: "Add a recipient first",
    });
  });

  it("blocks a send whose only recipient is not a plausible address", () => {
    expect(
      validateSend({ ...BODY, to: [{ name: null, address: "not-an-address" }], cc: [], bcc: [] }),
    ).toMatchObject({ kind: "blocked" });
  });

  it("accepts a Bcc-only send — a recipient is a recipient wherever it sits", () => {
    expect(validateSend({ ...BODY, to: [], cc: [], bcc: [ADA] })).toEqual({ kind: "ready" });
  });

  it("warns about an empty subject rather than blocking it", () => {
    expect(validateSend({ to: [ADA], cc: [], bcc: [], subject: "  ", bodyIsEmpty: false })).toEqual(
      { kind: "warn", reason: "No subject — send?" },
    );
  });

  it("warns about an empty body", () => {
    expect(
      validateSend({ to: [ADA], cc: [], bcc: [], subject: "Lunch", bodyIsEmpty: true }),
    ).toEqual({ kind: "warn", reason: "Empty body — send?" });
  });

  it("names both when both are missing, rather than leaving the User to guess", () => {
    expect(validateSend({ to: [ADA], cc: [], bcc: [], subject: "", bodyIsEmpty: true })).toEqual({
      kind: "warn",
      reason: "No subject or body — send?",
    });
  });

  it("blocks before it warns: a recipient-less, subject-less send is blocked, not warned", () => {
    expect(validateSend({ to: [], cc: [], bcc: [], subject: "", bodyIsEmpty: true })).toMatchObject(
      { kind: "blocked" },
    );
  });
});
