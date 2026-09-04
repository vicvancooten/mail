import { describe, expect, it } from "vitest";
import { bulkTriageFolderRoleForFolder, groupDateRange } from "./group-target.js";
import { PINNED_GROUP_LABEL, timeGroupLabel } from "./time-groups.js";

const NOW = new Date("2026-06-25T15:00:00.000Z"); // a Thursday

/** Every ordinary date-group label round-trips: the timestamp that produced
 * the label falls back inside the range `groupDateRange` hands back for it —
 * the literal property that makes the batch endpoint's target set name the
 * same Threads the header claims to (#67, #77). */
function expectRoundTrip(iso: string) {
  const label = timeGroupLabel(iso, NOW);
  const range = groupDateRange(label, NOW);
  expect(range, `expected a range for label "${label}" (from ${iso})`).not.toBeNull();
  const ts = new Date(iso).getTime();
  if (range?.since !== null)
    expect(ts).toBeGreaterThanOrEqual(new Date(range?.since as string).getTime());
  if (range?.until !== null) expect(ts).toBeLessThan(new Date(range?.until as string).getTime());
}

describe("groupDateRange", () => {
  it("round-trips Today back to a range containing the timestamp that produced it", () => {
    expectRoundTrip("2026-06-25T09:00:00.000Z");
  });

  it("round-trips Yesterday", () => {
    expectRoundTrip("2026-06-24T09:00:00.000Z");
  });

  it("round-trips This week", () => {
    expectRoundTrip("2026-06-20T09:00:00.000Z");
  });

  it("round-trips Last week", () => {
    expectRoundTrip("2026-06-13T09:00:00.000Z");
  });

  it("round-trips This month", () => {
    expectRoundTrip("2026-06-02T09:00:00.000Z");
  });

  it("round-trips the previous named month", () => {
    expectRoundTrip("2026-05-10T09:00:00.000Z");
  });

  it("round-trips the month before that, named", () => {
    expectRoundTrip("2026-04-10T09:00:00.000Z");
  });

  it("round-trips a year-qualified month label", () => {
    expectRoundTrip("2025-05-10T09:00:00.000Z");
  });

  it("Older has no lower bound and an upper bound at the two-months-ago cutoff", () => {
    const range = groupDateRange("Older", NOW);
    expect(range).toEqual({ since: null, until: new Date(2026, 3, 1).toISOString() });
    expectRoundTrip("2010-01-01T00:00:00.000Z");
  });

  it("Today is open-ended: no upper bound, so a Thread arriving after the request still lands in it", () => {
    expect(groupDateRange("Today", NOW)).toEqual({
      since: new Date(2026, 5, 25).toISOString(),
      until: null,
    });
  });

  it("returns null for Pinned — its label carries no date bound of its own", () => {
    expect(groupDateRange(PINNED_GROUP_LABEL, NOW)).toBeNull();
  });

  it("returns null for Undated — nothing to bound a null lastMessageAt by", () => {
    expect(groupDateRange("Undated", NOW)).toBeNull();
  });

  it("returns null for a label that isn't in the ladder at all", () => {
    expect(groupDateRange("Not a real group", NOW)).toBeNull();
  });
});

describe("bulkTriageFolderRoleForFolder", () => {
  it("maps the four mailbox-backed folders to their wire role", () => {
    expect(bulkTriageFolderRoleForFolder("inbox")).toBe("inbox");
    expect(bulkTriageFolderRoleForFolder("archive")).toBe("archive");
    expect(bulkTriageFolderRoleForFolder("trash")).toBe("trash");
    expect(bulkTriageFolderRoleForFolder("sent")).toBe("sent");
  });

  it("has no role for the folders that aren't a Thread.lastMessageAt-ordered mailbox view", () => {
    expect(bulkTriageFolderRoleForFolder("screener")).toBeNull();
    expect(bulkTriageFolderRoleForFolder("snoozed")).toBeNull();
    expect(bulkTriageFolderRoleForFolder("pinned")).toBeNull();
    expect(bulkTriageFolderRoleForFolder("drafts")).toBeNull();
  });
});
