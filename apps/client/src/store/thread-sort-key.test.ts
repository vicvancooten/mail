import { describe, expect, it } from "vitest";
import { makeThread } from "../test-support/mail-fixtures.js";
import { threadSortKey } from "./thread-sort-key.js";

describe("threadSortKey", () => {
  it("orders lexicographically by date across mixed ISO precisions", () => {
    const whole = threadSortKey(makeThread("a", "acct", { lastMessageAt: "2026-06-01T12:00:00Z" }));
    const fractional = threadSortKey(
      makeThread("b", "acct", { lastMessageAt: "2026-06-01T12:00:00.500Z" }),
    );

    // Raw, `.500Z` sorts *before* `Z` because "." < "Z" — the normalization
    // to a fixed-width millisecond form is what stops a half-second-newer
    // Thread from sorting older.
    expect(whole < fractional).toBe(true);
  });

  it("sorts an undated Thread below every dated one", () => {
    const undated = threadSortKey(
      makeThread("a", "acct", { lastMessageAt: null, firstMessageAt: null }),
    );
    const dated = threadSortKey(makeThread("b", "acct", { lastMessageAt: "1970-01-01T00:00:00Z" }));

    expect(undated < dated).toBe(true);
  });

  it("falls back to the first message's date when the last one is missing", () => {
    const key = threadSortKey(
      makeThread("a", "acct", { lastMessageAt: null, firstMessageAt: "2026-06-01T12:00:00Z" }),
    );

    expect(key).toBe("2026-06-01T12:00:00.000Z|a");
  });

  it("breaks a timestamp tie by id, so the ordering is total", () => {
    const at = "2026-06-01T12:00:00.000Z";
    const first = threadSortKey(makeThread("a", "acct", { lastMessageAt: at }));
    const second = threadSortKey(makeThread("b", "acct", { lastMessageAt: at }));

    expect(first).not.toBe(second);
    expect(first < second).toBe(true);
  });
});
