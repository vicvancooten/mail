import { describe, expect, it, vi } from "vitest";
import { type BadgeHost, setBadgeCount } from "./badge.js";

function fakeHost(): BadgeHost & {
  setAppBadge: ReturnType<typeof vi.fn>;
  clearAppBadge: ReturnType<typeof vi.fn>;
} {
  return {
    setAppBadge: vi.fn().mockResolvedValue(undefined),
    clearAppBadge: vi.fn().mockResolvedValue(undefined),
  };
}

describe("setBadgeCount", () => {
  it("calls setAppBadge with a positive count when permission is granted", async () => {
    const host = fakeHost();
    await setBadgeCount(3, { navigator: host, permission: "granted" });
    expect(host.setAppBadge).toHaveBeenCalledWith(3);
    expect(host.clearAppBadge).not.toHaveBeenCalled();
  });

  it("clears the badge for a count of 0", async () => {
    const host = fakeHost();
    await setBadgeCount(0, { navigator: host, permission: "granted" });
    expect(host.clearAppBadge).toHaveBeenCalled();
    expect(host.setAppBadge).not.toHaveBeenCalled();
  });

  it("never touches the Badging API when permission is not granted — a denied device does not badge", async () => {
    const host = fakeHost();
    await setBadgeCount(3, { navigator: host, permission: "denied" });
    await setBadgeCount(3, { navigator: host, permission: "default" });
    expect(host.setAppBadge).not.toHaveBeenCalled();
    expect(host.clearAppBadge).not.toHaveBeenCalled();
  });

  it("is a no-op where the Badging API doesn't exist", async () => {
    await expect(
      setBadgeCount(3, { navigator: {}, permission: "granted" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a rejection from setAppBadge — a badge is cosmetic", async () => {
    const host: BadgeHost = { setAppBadge: vi.fn().mockRejectedValue(new Error("nope")) };
    await expect(
      setBadgeCount(3, { navigator: host, permission: "granted" }),
    ).resolves.toBeUndefined();
  });
});
