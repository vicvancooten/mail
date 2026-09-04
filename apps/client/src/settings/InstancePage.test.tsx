import type { InstanceInfoResponse } from "@mail/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as instanceApi from "../api/instance.js";
import { InstancePage } from "./InstancePage.js";

vi.mock("../api/instance.js", () => ({
  fetchInstanceInfo: vi.fn(),
}));

function instanceInfo(overrides: Partial<InstanceInfoResponse> = {}): InstanceInfoResponse {
  return {
    version: "1.0.0",
    imageTag: "test-tag",
    webPush: { configured: false, generateCommand: "mail generate-vapid-keys" },
    systemMailer: { configured: false },
    publicUrl: { value: "https://mail.example.com", isSecureContext: true },
    providers: [
      {
        provider: "google",
        status: "not_registered",
        redirectUri: "https://mail.example.com/auth/oauth/google/callback",
        clientIdPreview: null,
        mailAccountCount: 0,
        needsReauthCount: 0,
        lastRefreshAt: null,
        lastRefreshError: null,
      },
      {
        provider: "microsoft",
        status: "not_registered",
        redirectUri: "https://mail.example.com/auth/oauth/microsoft/callback",
        clientIdPreview: null,
        mailAccountCount: 0,
        needsReauthCount: 0,
        lastRefreshAt: null,
        lastRefreshError: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("InstancePage", () => {
  it("renders a Providers section listing Google and Microsoft, both Not registered by default", async () => {
    vi.mocked(instanceApi.fetchInstanceInfo).mockResolvedValue(instanceInfo());
    render(<InstancePage />);

    expect(await screen.findByText("Providers")).toBeDefined();
    expect(screen.getByText("Google")).toBeDefined();
    expect(screen.getByText("Microsoft")).toBeDefined();
    expect(screen.getAllByText("Not registered")).toHaveLength(2);
  });

  it("renders Registered, untested for a Provider with a Registration", async () => {
    vi.mocked(instanceApi.fetchInstanceInfo).mockResolvedValue(
      instanceInfo({
        providers: [
          {
            provider: "google",
            status: "registered_untested",
            redirectUri: "https://mail.example.com/auth/oauth/google/callback",
            clientIdPreview: "abc.apps.googleusercontent.com",
            mailAccountCount: 2,
            needsReauthCount: 0,
            lastRefreshAt: null,
            lastRefreshError: null,
          },
          {
            provider: "microsoft",
            status: "not_registered",
            redirectUri: "https://mail.example.com/auth/oauth/microsoft/callback",
            clientIdPreview: null,
            mailAccountCount: 0,
            needsReauthCount: 0,
            lastRefreshAt: null,
            lastRefreshError: null,
          },
        ],
      }),
    );
    render(<InstancePage />);

    expect(await screen.findByText(/Registered, untested/)).toBeDefined();
    expect(screen.getByText("abc.apps.googleusercontent.com")).toBeDefined();
    expect(screen.getByText("Not registered")).toBeDefined();
  });

  it("flags a plain-http, non-loopback Public URL on every Provider card", async () => {
    vi.mocked(instanceApi.fetchInstanceInfo).mockResolvedValue(
      instanceInfo({ publicUrl: { value: "http://mail.example.com", isSecureContext: false } }),
    );
    render(<InstancePage />);

    expect(await screen.findAllByText(/reject this redirect URI/)).toHaveLength(2);
  });
});
