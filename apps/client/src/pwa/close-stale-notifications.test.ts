import { describe, expect, it, vi } from "vitest";
import {
  closeStaleThreadNotification,
  type NotificationRegistryLike,
} from "./close-stale-notifications.js";

describe("closeStaleThreadNotification", () => {
  it("closes every notification tagged for this Thread", async () => {
    const close1 = vi.fn();
    const close2 = vi.fn();
    const registry: NotificationRegistryLike = {
      getNotifications: vi.fn(async () => [{ close: close1 }, { close: close2 }]),
    };

    await closeStaleThreadNotification("thread-1", registry);

    expect(registry.getNotifications).toHaveBeenCalledWith({ tag: "mail-thread-thread-1" });
    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing is tagged for this Thread", async () => {
    const registry: NotificationRegistryLike = {
      getNotifications: vi.fn(async () => []),
    };

    await expect(closeStaleThreadNotification("thread-1", registry)).resolves.toBeUndefined();
  });

  it("swallows a registry failure — cosmetic cleanup never surfaces an error", async () => {
    const registry: NotificationRegistryLike = {
      getNotifications: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(closeStaleThreadNotification("thread-1", registry)).resolves.toBeUndefined();
  });

  it("is a no-op with no registry at all (no Service Worker — vite dev, jsdom)", async () => {
    await expect(closeStaleThreadNotification("thread-1", undefined)).resolves.toBeUndefined();
  });
});
