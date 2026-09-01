import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pushApi from "../api/push.js";
import {
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  type PushManagerLike,
  type PushSubscriptionLike,
  pushSupportState,
  urlBase64ToUint8Array,
} from "./push.js";

vi.mock("../api/push.js", () => ({
  registerPushSubscription: vi.fn().mockResolvedValue(undefined),
  unregisterPushSubscription: vi.fn().mockResolvedValue(undefined),
  fetchPushConfig: vi.fn(),
}));

function fakePushManager(subscription: PushSubscriptionLike): PushManagerLike {
  return {
    subscribe: vi.fn().mockResolvedValue(subscription),
    getSubscription: vi.fn().mockResolvedValue(null),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pushSupportState", () => {
  it("is 'unsupported' when any of Notification/serviceWorker/PushManager is missing", () => {
    expect(
      pushSupportState(undefined, { serviceWorker: { ready: Promise.resolve({} as never) } }),
    ).toBe("unsupported");
    expect(pushSupportState({ requestPermission: vi.fn() }, undefined)).toBe("unsupported");
  });
});

describe("enablePushOnThisDevice", () => {
  it("subscribes and registers the subscription once permission is granted", async () => {
    const subscription = {
      endpoint: "https://push.example.test/abc",
      toJSON: () => ({
        endpoint: "https://push.example.test/abc",
        keys: { p256dh: "p", auth: "a" },
      }),
      unsubscribe: vi.fn(),
    };
    const pushManager = fakePushManager(subscription);
    const pushHost = { serviceWorker: { ready: Promise.resolve({ pushManager }) } };
    const notificationHost = { requestPermission: vi.fn().mockResolvedValue("granted" as const) };

    const result = await enablePushOnThisDevice("vapid-public-key", { notificationHost, pushHost });

    expect(result).toEqual({ ok: true });
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(pushApi.registerPushSubscription).toHaveBeenCalledWith({
      endpoint: "https://push.example.test/abc",
      keys: { p256dh: "p", auth: "a" },
    });
  });

  it("never subscribes when permission is denied", async () => {
    const pushManager = fakePushManager({} as PushSubscriptionLike);
    const pushHost = { serviceWorker: { ready: Promise.resolve({ pushManager }) } };
    const notificationHost = { requestPermission: vi.fn().mockResolvedValue("denied" as const) };

    const result = await enablePushOnThisDevice("vapid-public-key", { notificationHost, pushHost });

    expect(result).toEqual({ ok: false, reason: "permission_denied" });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushApi.registerPushSubscription).not.toHaveBeenCalled();
  });

  it("reports unsupported when there is no service worker host at all", async () => {
    const notificationHost = { requestPermission: vi.fn() };
    const result = await enablePushOnThisDevice("k", { notificationHost, pushHost: undefined });
    expect(result).toEqual({ ok: false, reason: "unsupported" });
    expect(notificationHost.requestPermission).not.toHaveBeenCalled();
  });
});

describe("disablePushOnThisDevice", () => {
  it("unsubscribes locally and tells the backend to forget the endpoint", async () => {
    const subscription = {
      endpoint: "https://push.example.test/abc",
      toJSON: () => ({}),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const pushManager: PushManagerLike = {
      subscribe: vi.fn(),
      getSubscription: vi.fn().mockResolvedValue(subscription),
    };
    const pushHost = { serviceWorker: { ready: Promise.resolve({ pushManager }) } };

    await disablePushOnThisDevice(pushHost);

    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(pushApi.unregisterPushSubscription).toHaveBeenCalledWith(
      "https://push.example.test/abc",
    );
  });

  it("is a no-op when this device has no subscription", async () => {
    const pushManager: PushManagerLike = {
      subscribe: vi.fn(),
      getSubscription: vi.fn().mockResolvedValue(null),
    };
    const pushHost = { serviceWorker: { ready: Promise.resolve({ pushManager }) } };
    await disablePushOnThisDevice(pushHost);
    expect(pushApi.unregisterPushSubscription).not.toHaveBeenCalled();
  });
});

describe("urlBase64ToUint8Array", () => {
  it("round-trips a URL-safe base64 VAPID key into raw bytes", () => {
    // "hi" -> base64 "aGk=" -> url-safe (no padding needed here) "aGk"
    const bytes = urlBase64ToUint8Array("aGk");
    expect(Array.from(bytes)).toEqual([104, 105]); // "h", "i"
  });
});
