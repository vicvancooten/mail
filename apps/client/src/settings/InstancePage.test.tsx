import type { InstanceInfoResponse } from "@mail/shared";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { InstancePage } from "./InstancePage.js";

/**
 * The Owner-only Instance page (#104) and the one repair it offers: minting
 * the Web Push keypair (ADR-0015 as amended). An ordinary instance mints it
 * at first boot and never shows the button — what these cases pin is that
 * the button appears exactly where a press is the actual fix, and that the
 * env-pinned instance still gets the CLI command instead.
 */

function info(overrides: Partial<InstanceInfoResponse["webPush"]> = {}): InstanceInfoResponse {
  return {
    version: "0.0.0",
    imageTag: "test-tag",
    webPush: {
      configured: false,
      generateCommand: "mail generate-vapid-keys",
      canGenerate: true,
      ...overrides,
    },
    systemMailer: { configured: false },
    publicUrl: { value: "http://localhost:3000", isSecureContext: true },
  };
}

/** `/instance/health` answers from `healths` in order, so a reload after the press can report the new fact. */
function stubFetch(healths: InstanceInfoResponse[], generate?: () => Response) {
  const queue = [...healths];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/instance/health") {
      return Promise.resolve(jsonResponse(queue.length > 1 ? queue.shift() : queue[0]));
    }
    if (url === "/instance/vapid-keys" && init?.method === "POST") {
      return Promise.resolve(
        generate ? generate() : jsonResponse({ publicKey: "generated", replaced: false }),
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InstancePage", () => {
  it("offers a press rather than a shell command when the instance owns the keypair", async () => {
    stubFetch([info(), info({ configured: true })]);
    render(<InstancePage />);

    const button = await screen.findByRole("button", { name: "Generate keys" });
    expect(screen.queryByText("mail generate-vapid-keys")).toBeNull();

    await userEvent.click(button);

    await waitFor(() => expect(screen.getByText("Configured")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
  });

  it("warns that devices must re-enable notifications when the keypair was replaced", async () => {
    stubFetch([info(), info({ configured: true })], () =>
      jsonResponse({ publicKey: "generated", replaced: true }),
    );
    render(<InstancePage />);

    await userEvent.click(await screen.findByRole("button", { name: "Generate keys" }));

    await waitFor(() => expect(screen.getByText(/enable notifications again/i)).toBeTruthy());
  });

  it("keeps the CLI command on an env-pinned instance, where a press would be overridden on the next boot", async () => {
    stubFetch([info({ canGenerate: false })]);
    render(<InstancePage />);

    expect(await screen.findByText("mail generate-vapid-keys")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
  });

  it("says so, and stays pressable, when generation fails", async () => {
    stubFetch([info()], () => jsonResponse({ error: "generation_failed" }, { status: 500 }));
    render(<InstancePage />);

    await userEvent.click(await screen.findByRole("button", { name: "Generate keys" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Generate keys" })).toBeTruthy();
  });
});
