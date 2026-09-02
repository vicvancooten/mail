import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pushApi from "../api/push.js";
import { PushNotificationsSection } from "./PushNotificationsSection.js";

vi.mock("../api/push.js", () => ({
  fetchPushConfig: vi.fn(),
  registerPushSubscription: vi.fn().mockResolvedValue(undefined),
  unregisterPushSubscription: vi.fn().mockResolvedValue(undefined),
}));

function stubPushSupport(getSubscription: () => Promise<unknown>) {
  Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription,
          subscribe: vi.fn().mockResolvedValue({
            endpoint: "https://push.example.test/abc",
            toJSON: () => ({
              endpoint: "https://push.example.test/abc",
              keys: { p256dh: "p", auth: "a" },
            }),
            unsubscribe: vi.fn().mockResolvedValue(true),
          }),
        },
      }),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("PushNotificationsSection", () => {
  it("renders nothing while the VAPID config hasn't loaded, and nothing when unconfigured", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: null });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "default" },
    });
    stubPushSupport(() => Promise.resolve(null));

    render(<PushNotificationsSection />);
    expect(screen.queryByText("Push notifications")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Push notifications")).toBeNull();
  });

  it("renders nothing when this browser has no Push API at all", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: undefined });
    Object.defineProperty(globalThis.navigator, "serviceWorker", {
      configurable: true,
      value: undefined,
    });

    render(<PushNotificationsSection />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Push notifications")).toBeNull();
  });

  it("shows an Enable button when configured, supported, and not yet subscribed", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "default" },
    });
    stubPushSupport(() => Promise.resolve(null));

    render(<PushNotificationsSection />);
    expect(await screen.findByRole("button", { name: "Enable on this device" })).toBeDefined();
  });

  it("shows the blocked explanation for a denied device, with no button", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "denied" },
    });
    stubPushSupport(() => Promise.resolve(null));

    render(<PushNotificationsSection />);
    expect(await screen.findByText(/blocked/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a Disable button when already subscribed", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted" },
    });
    stubPushSupport(() => Promise.resolve({ endpoint: "https://push.example.test/existing" }));

    render(<PushNotificationsSection />);
    expect(await screen.findByRole("button", { name: "Disable on this device" })).toBeDefined();
  });

  it("registers the subscription with the backend when Enable is clicked", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: vi.fn().mockResolvedValue("granted") },
    });
    stubPushSupport(() => Promise.resolve(null));

    render(<PushNotificationsSection />);
    const button = await screen.findByRole("button", { name: "Enable on this device" });
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pushApi.registerPushSubscription).toHaveBeenCalledWith({
      endpoint: "https://push.example.test/abc",
      keys: { p256dh: "p", auth: "a" },
    });
  });
});
