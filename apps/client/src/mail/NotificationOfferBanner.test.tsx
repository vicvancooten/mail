import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pushApi from "../api/push.js";
import { notifyTriageSucceeded, resetNotificationOfferTrigger } from "../pwa/notification-offer.js";
import { writeNotificationOfferShown } from "./device-preferences.js";
import { NotificationOfferBanner } from "./NotificationOfferBanner.js";

vi.mock("../api/push.js", () => ({
  fetchPushConfig: vi.fn(),
  registerPushSubscription: vi.fn().mockResolvedValue(undefined),
  unregisterPushSubscription: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetNotificationOfferTrigger();
  globalThis.localStorage?.clear();
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: "default" },
  });
  // jsdom has no Push API at all — `pushSupportState()` needs just enough of
  // one to read as "supported, undecided" rather than "unsupported".
  Object.defineProperty(globalThis, "PushManager", { configurable: true, value: class {} });
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }),
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("NotificationOfferBanner", () => {
  it("renders nothing until the first successful triage session fires", () => {
    render(<NotificationOfferBanner />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the offer once triage succeeds, when push is configured and permission is undecided", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    render(<NotificationOfferBanner />);

    await act(async () => {
      notifyTriageSucceeded();
      await Promise.resolve();
    });

    expect(await screen.findByRole("status")).toBeDefined();
  });

  it("never shows anything when the operator hasn't configured Web Push", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: null });
    render(<NotificationOfferBanner />);

    await act(async () => {
      notifyTriageSucceeded();
      await Promise.resolve();
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("never shows again once already shown on this device", async () => {
    writeNotificationOfferShown();
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    render(<NotificationOfferBanner />);

    await act(async () => {
      notifyTriageSucceeded();
      await Promise.resolve();
    });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismissing marks the offer shown, so a later trigger this session does nothing further", async () => {
    vi.mocked(pushApi.fetchPushConfig).mockResolvedValue({ vapidPublicKey: "test-key" });
    render(<NotificationOfferBanner />);
    await act(async () => {
      notifyTriageSucceeded();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("status")).toBeNull();

    // A brand-new banner instance (as if a fresh mount elsewhere) also
    // stays silent — the persisted flag, not just this component's state.
    resetNotificationOfferTrigger();
    render(<NotificationOfferBanner />);
    await act(async () => {
      notifyTriageSucceeded();
      await Promise.resolve();
    });
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });
});
