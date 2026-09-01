import { describe, expect, it } from "vitest";
import { parseHeadline } from "./headline.js";

describe("parseHeadline", () => {
  it("splits plain text around a matched span", () => {
    expect(parseHeadline("please see the \x01invoice\x02 attached")).toEqual([
      { text: "please see the ", matched: false, offset: 0 },
      { text: "invoice", matched: true, offset: 16 },
      { text: " attached", matched: false, offset: 24 },
    ]);
  });

  it("handles multiple matched spans", () => {
    expect(parseHeadline("\x01invoice\x02 for \x01march\x02")).toEqual([
      { text: "invoice", matched: true, offset: 1 },
      { text: " for ", matched: false, offset: 9 },
      { text: "march", matched: true, offset: 15 },
    ]);
  });

  it("returns plain text unchanged when nothing matched", () => {
    expect(parseHeadline("nothing matched here")).toEqual([
      { text: "nothing matched here", matched: false, offset: 0 },
    ]);
  });
});
