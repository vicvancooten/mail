import { afterEach, describe, expect, it, vi } from "vitest";
import { stubMatchMedia } from "./match-media.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stubMatchMedia", () => {
  it("updates matches before firing the synthetic change event", () => {
    const { setMatches } = stubMatchMedia(() => false);
    const mql = globalThis.matchMedia("(max-width: 700px)");
    const seen: boolean[] = [];

    mql.addEventListener("change", (event) => {
      seen.push(mql.matches);
      seen.push(event.matches);
    });

    expect(mql.matches).toBe(false);

    setMatches("(max-width: 700px)", true);

    expect(mql.matches).toBe(true);
    expect(seen).toEqual([true, true]);
  });
});
