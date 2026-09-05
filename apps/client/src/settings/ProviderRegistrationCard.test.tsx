import type { ProviderHealth } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as providersApi from "../api/providers.js";
import { ProviderRegistrationCard } from "./ProviderRegistrationCard.js";

vi.mock("../api/providers.js", () => ({
  saveProviderRegistration: vi.fn(),
  fetchProviderDeletePreview: vi.fn(),
  deleteProviderRegistration: vi.fn(),
}));

function health(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    provider: "google",
    status: "not_registered",
    redirectUri: "https://mail.example.com/auth/oauth/google/callback",
    clientIdPreview: null,
    mailAccountCount: 0,
    needsReauthCount: 0,
    lastRefreshAt: null,
    lastRefreshError: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ProviderRegistrationCard", () => {
  it("shows Not registered with a save form when there is no Registration yet", async () => {
    render(<ProviderRegistrationCard health={health()} isSecureContext onChanged={vi.fn()} />);
    expect(screen.getByText("Not registered")).toBeDefined();
    expect(screen.getByLabelText("Client ID")).toBeDefined();
    expect(screen.getByLabelText("Client secret")).toBeDefined();
  });

  it("saves a Registration and reports the change", async () => {
    vi.mocked(providersApi.saveProviderRegistration).mockResolvedValue(
      health({ status: "registered_untested", clientIdPreview: "abc.apps.googleusercontent.com" }),
    );
    const onChanged = vi.fn();
    render(<ProviderRegistrationCard health={health()} isSecureContext onChanged={onChanged} />);

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "abc.apps.googleusercontent.com" },
    });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "shh" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(providersApi.saveProviderRegistration).toHaveBeenCalledWith("google", {
        clientId: "abc.apps.googleusercontent.com",
        clientSecret: "shh",
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows Registered, untested with the client id, and a Replace action instead of the form", () => {
    render(
      <ProviderRegistrationCard
        health={health({ status: "registered_untested", clientIdPreview: "abc-client-id" })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/Registered, untested/)).toBeDefined();
    expect(screen.getByText("abc-client-id")).toBeDefined();
    expect(screen.queryByLabelText("Client ID")).toBeNull();
    expect(screen.getByRole("button", { name: "Replace" })).toBeDefined();
  });

  it("Replace reveals the save form again", () => {
    render(
      <ProviderRegistrationCard
        health={health({ status: "registered_untested", clientIdPreview: "abc-client-id" })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("Client ID")).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("shows Working with the last refresh time", () => {
    render(
      <ProviderRegistrationCard
        health={health({
          status: "working",
          clientIdPreview: "abc-client-id",
          lastRefreshAt: "2026-01-01T12:00:00.000Z",
        })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/Working/)).toBeDefined();
    expect(screen.getByText(/last refreshed/)).toBeDefined();
  });

  it("shows Failing with the last error and time", () => {
    render(
      <ProviderRegistrationCard
        health={health({
          status: "failing",
          clientIdPreview: "abc-client-id",
          lastRefreshAt: "2026-01-01T12:00:00.000Z",
          lastRefreshError: "network blip",
        })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/Failing/)).toBeDefined();
    expect(screen.getByText(/network blip/)).toBeDefined();
  });

  it("shows the Mail Account and Needs Reauth counts once registered", () => {
    render(
      <ProviderRegistrationCard
        health={health({
          status: "registered_untested",
          clientIdPreview: "abc-client-id",
          mailAccountCount: 3,
          needsReauthCount: 1,
        })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 Mail Accounts/)).toBeDefined();
    expect(screen.getByText(/1 Needs Reauth/)).toBeDefined();
  });

  it("shows the plain-http warning only when the Public URL isn't a secure context", () => {
    const { rerender } = render(
      <ProviderRegistrationCard health={health()} isSecureContext={false} onChanged={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/reject this redirect URI/);

    rerender(<ProviderRegistrationCard health={health()} isSecureContext onChanged={vi.fn()} />);
    expect(screen.queryByText(/reject this redirect URI/)).toBeNull();
  });

  it("Remove Registration previews the affected count before deleting anything", async () => {
    vi.mocked(providersApi.fetchProviderDeletePreview).mockResolvedValue({ mailAccountCount: 3 });
    render(
      <ProviderRegistrationCard
        health={health({ status: "registered_untested", clientIdPreview: "abc-client-id" })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Registration" }));
    expect(await screen.findByText(/3 Mail Accounts will stop syncing/)).toBeDefined();
    expect(providersApi.deleteProviderRegistration).not.toHaveBeenCalled();
  });

  it("Confirm removal calls delete and reports the change", async () => {
    vi.mocked(providersApi.fetchProviderDeletePreview).mockResolvedValue({ mailAccountCount: 1 });
    vi.mocked(providersApi.deleteProviderRegistration).mockResolvedValue(undefined);
    const onChanged = vi.fn();
    render(
      <ProviderRegistrationCard
        health={health({ status: "registered_untested", clientIdPreview: "abc-client-id" })}
        isSecureContext
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Registration" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm removal" }));

    await waitFor(() =>
      expect(providersApi.deleteProviderRegistration).toHaveBeenCalledWith("google"),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("Cancel on the delete preview backs out without deleting", async () => {
    vi.mocked(providersApi.fetchProviderDeletePreview).mockResolvedValue({ mailAccountCount: 1 });
    render(
      <ProviderRegistrationCard
        health={health({ status: "registered_untested", clientIdPreview: "abc-client-id" })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Registration" }));
    await screen.findByRole("button", { name: "Confirm removal" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Confirm removal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Registration" })).toBeDefined();
    expect(providersApi.deleteProviderRegistration).not.toHaveBeenCalled();
  });

  it("Copy puts the exact redirect URI on the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(
      <ProviderRegistrationCard
        health={health({ redirectUri: "https://mail.example.com/auth/oauth/google/callback" })}
        isSecureContext
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://mail.example.com/auth/oauth/google/callback"),
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeDefined();
  });
});
