import { describe, expect, it } from "vitest";
import { resolveRemoteImagesSetting } from "./mail-accounts.js";

describe("resolveRemoteImagesSetting", () => {
  it("passes an explicit choice through unchanged, regardless of Gatekeeper state (#146)", () => {
    expect(resolveRemoteImagesSetting("always", true)).toBe("always");
    expect(resolveRemoteImagesSetting("always", false)).toBe("always");
    expect(resolveRemoteImagesSetting("ask", true)).toBe("ask");
    expect(resolveRemoteImagesSetting("approved-only", false)).toBe("approved-only");
  });

  it("defaults unset to approved-only while Gatekeeper is on — today's behaviour preserved", () => {
    expect(resolveRemoteImagesSetting(null, true)).toBe("approved-only");
  });

  it("defaults unset to always while Gatekeeper is off — screening off doesn't inherit its strictest posture", () => {
    expect(resolveRemoteImagesSetting(null, false)).toBe("always");
  });
});
