import { describe, expect, it } from "vitest";
import { taperHeaderHeight, taperRowHeight, ungroupedRowHeight } from "./taper.js";

describe("taperRowHeight / taperHeaderHeight", () => {
  it("tapers comfortable row height strictly down from T1 (loudest) to T4 (quietest)", () => {
    const heights = ([1, 2, 3, 4] as const).map((tier) => taperRowHeight(tier, "comfortable"));
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
    expect(new Set(heights).size).toBe(4); // four visibly distinct tiers
  });

  it("tapers comfortable header height strictly down from T1 to T4", () => {
    const heights = ([1, 2, 3, 4] as const).map((tier) => taperHeaderHeight(tier, "comfortable"));
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
    expect(new Set(heights).size).toBe(4);
  });

  it("compact shifts every tier's row by the same fixed delta rather than flattening the taper", () => {
    const delta = ([1, 2, 3, 4] as const).map(
      (tier) => taperRowHeight(tier, "comfortable") - taperRowHeight(tier, "compact"),
    );
    expect(delta[0]).toBeGreaterThan(0);
    expect(new Set(delta).size).toBe(1); // one delta, applied identically to every tier

    // The taper itself survives compacting: still four distinct, descending sizes.
    const compact = ([1, 2, 3, 4] as const).map((tier) => taperRowHeight(tier, "compact"));
    expect(compact).toEqual([...compact].sort((a, b) => b - a));
    expect(new Set(compact).size).toBe(4);
  });

  it("compact shifts every tier's header by the same fixed delta too", () => {
    const delta = ([1, 2, 3, 4] as const).map(
      (tier) => taperHeaderHeight(tier, "comfortable") - taperHeaderHeight(tier, "compact"),
    );
    expect(delta[0]).toBeGreaterThan(0);
    expect(new Set(delta).size).toBe(1);
  });

  it("never lets the densest row get uncomfortably small — T4 compact stays no smaller than comfortable's own old floor", () => {
    // The complaint the taper existed to prevent went too far the other
    // way: T4 (Older/Undated/the two named months) compacted down to 26px,
    // barely enough for a 19px avatar with no room to breathe. The floor
    // now sits at comfortable's own *old* T4 height (32px) — the densest
    // tier a User can reach, at the densest density, still reads as a real
    // row rather than a tick mark.
    expect(taperRowHeight(4, "compact")).toBeGreaterThanOrEqual(32);
  });
});

describe("ungroupedRowHeight", () => {
  it("gives search's ranked, ungrouped list a flat height per density — no taper to key off", () => {
    expect(ungroupedRowHeight("comfortable")).toBeGreaterThan(ungroupedRowHeight("compact"));
  });
});
