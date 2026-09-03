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
});

describe("ungroupedRowHeight", () => {
  it("gives search's ranked, ungrouped list a flat height per density — no taper to key off", () => {
    expect(ungroupedRowHeight("comfortable")).toBeGreaterThan(ungroupedRowHeight("compact"));
  });
});
