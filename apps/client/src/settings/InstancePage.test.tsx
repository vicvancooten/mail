import type { InstanceInfoResponse } from "@mail/shared";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as instanceApi from "../api/instance.js";
import * as providersApi from "../api/providers.js";
import { InstancePage } from "./InstancePage.js";

vi.mock("../api/instance.js", () => ({
  fetchInstanceInfo: vi.fn(),
  generateVapidKeys: vi.fn(),
}));

vi.mock("../api/providers.js", () => ({
  saveProviderRegistration: vi.fn(),
  fetchProviderDeletePreview: vi.fn(),
  deleteProviderRegistration: vi.fn(),
}));

/**
 * The Owner-only Instance page (#104, #115): the Web Push keypair repair
 * (ADR-0015 as amended) — the button appears exactly where a press is the
 * actual fix, the env-pinned instance still gets the CLI command instead —
 * and the Providers section (#115, ADR-0021) listing Google and Microsoft
 * Provider Health.
 */
function instanceInfo(overrides: Partial<InstanceInfoResponse> = {}): InstanceInfoResponse {
  return {
    version: "1.0.0",
    imageTag: "test-tag",
    webPush: {
      configured: false,
      generateCommand: "mail generate-vapid-keys",
      canGenerate: true,
    },
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

  it("offers a press rather than a shell command when the instance owns the keypair", async () => {
    vi.mocked(instanceApi.fetchInstanceInfo)
      .mockResolvedValueOnce(instanceInfo())
      .mockResolvedValueOnce(
        instanceInfo({
          webPush: {
            configured: true,
            generateCommand: "mail generate-vapid-keys",
            canGenerate: true,
          },
        }),
      );
    vi.mocked(instanceApi.generateVapidKeys).mockResolvedValue({
      publicKey: "generated",
      replaced: false,
    });
    render(<InstancePage />);

    const button = await screen.findByRole("button", { name: "Generate keys" });
    expect(screen.queryByText("mail generate-vapid-keys")).toBeNull();

    await userEvent.click(button);

    await waitFor(() => expect(screen.getByText("Configured")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
  });

  it("warns that devices must re-enable notifications when the keypair was replaced", async () => {
    vi.mocked(instanceApi.fetchInstanceInfo)
      .mockResolvedValueOnce(instanceInfo())
      .mockResolvedValueOnce(
        instanceInfo({
          webPush: {
            configured: true,
            generateCommand: "mail generate-vapid-keys",
            canGenerate: true,
          },
        }),
      );
    vi.mocked(instanceApi.generateVapidKeys).mockResolvedValue({
      publicKey: "generated",
      replaced: true,
    });
    render(<InstancePage />);

    await userEvent.click(await screen.findByRole("button", { name: "Generate keys" }));

    await waitFor(() => expect(screen.getByText(/enable notifications again/i)).toBeTruthy());
  });

  it("keeps the CLI command on an env-pinned instance, where a press would be overridden on the next boot", async () => {
    vi.mocked(instanceApi.fetchInstanceInfo).mockResolvedValue(
      instanceInfo({
        webPush: {
          configured: false,
          generateCommand: "mail generate-vapid-keys",
          canGenerate: false,
        },
      }),
    );
    render(<InstancePage />);

    expect(await screen.findByText("mail generate-vapid-keys")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
  });

  it("says so, and stays pressable, when generation fails", async () => {
    vi.mocked(instanceApi.fetchInstanceInfo).mockResolvedValue(instanceInfo());
    vi.mocked(instanceApi.generateVapidKeys).mockRejectedValue(new Error("generation_failed"));
    render(<InstancePage />);

    await userEvent.click(await screen.findByRole("button", { name: "Generate keys" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Generate keys" })).toBeTruthy();
  });

  it("clears a transient load error after a later successful reload", async () => {
    const updatedInfo = instanceInfo({
      providers: [
        {
          provider: "google",
          status: "registered_untested",
          redirectUri: "https://mail.example.com/auth/oauth/google/callback",
          clientIdPreview: "abc.apps.googleusercontent.com",
          mailAccountCount: 1,
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
    });
    const updatedGoogle = updatedInfo.providers[0];
    if (!updatedGoogle) throw new Error("expected Google provider fixture");

    vi.mocked(instanceApi.fetchInstanceInfo)
      .mockResolvedValueOnce(instanceInfo())
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(updatedInfo);
    vi.mocked(providersApi.saveProviderRegistration).mockResolvedValue(updatedGoogle);
    render(<InstancePage />);

    expect(await screen.findByText("Providers")).toBeTruthy();
    const googleCard = screen.getByRole("heading", { name: "Google" }).closest("section");
    if (!googleCard) throw new Error("expected Google provider card");

    await userEvent.type(within(googleCard).getByLabelText("Client ID"), "client-id");
    await userEvent.type(within(googleCard).getByLabelText("Client secret"), "client-secret");
    await userEvent.click(within(googleCard).getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't load instance info.",
    );

    await userEvent.type(within(googleCard).getByLabelText("Client ID"), "client-id");
    await userEvent.type(within(googleCard).getByLabelText("Client secret"), "client-secret");
    await userEvent.click(within(googleCard).getByRole("button", { name: "Save" }));

    await screen.findByText("abc.apps.googleusercontent.com");
    await waitFor(() => expect(screen.queryByText("Couldn't load instance info.")).toBeNull());
  });
});
