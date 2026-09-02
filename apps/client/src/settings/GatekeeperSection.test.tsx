import type { GatekeeperMutationResponse, GatekeeperStatusResponse } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatekeeperApi from "../api/gatekeeper.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { listQueuedMutations } from "../store/mutation-queue.js";
import { makeMailAccount } from "../test-support/mail-fixtures.js";
import { GatekeeperSection } from "./GatekeeperSection.js";

vi.mock("../api/gatekeeper.js", () => ({
  fetchGatekeeperStatus: vi.fn(),
  enableGatekeeper: vi.fn(),
  disableGatekeeper: vi.fn(),
  resetGatekeeper: vi.fn(),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  const name = `gatekeeper-settings-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function status(overrides: Partial<GatekeeperStatusResponse> = {}): GatekeeperStatusResponse {
  return {
    gatekeeper: { enabled: false, cutoff: null },
    approvedCount: 0,
    blocked: [],
    ...overrides,
  };
}

function mutationStatus(
  overrides: Partial<GatekeeperMutationResponse> = {},
): GatekeeperMutationResponse {
  return { ...status(), seeded: 0, ...overrides };
}

describe("GatekeeperSection", () => {
  it("enabling calls the API and reports how many senders the seed approved", async () => {
    vi.mocked(gatekeeperApi.fetchGatekeeperStatus).mockResolvedValue(status());
    vi.mocked(gatekeeperApi.enableGatekeeper).mockResolvedValue(
      mutationStatus({
        gatekeeper: { enabled: true, cutoff: "2026-06-01T00:00:00.000Z" },
        approvedCount: 42,
        seeded: 42,
      }),
    );

    render(<GatekeeperSection account={makeMailAccount("acct-1")} />);
    const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Enabled" });
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect((await screen.findByRole("status")).textContent).toBe(
      "Approved 42 senders from your Sent history.",
    );
    expect(gatekeeperApi.enableGatekeeper).toHaveBeenCalledWith("acct-1");
  });

  it("lists Blocked Senders, and Unblock queues the Optimistic Action and removes the row", async () => {
    vi.mocked(gatekeeperApi.fetchGatekeeperStatus).mockResolvedValue(
      status({
        gatekeeper: { enabled: true, cutoff: "2026-06-01T00:00:00.000Z" },
        blocked: [
          {
            scope: "address",
            value: "spammer@example.test",
            source: "screener",
            decidedAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      }),
    );

    render(<GatekeeperSection account={makeMailAccount("acct-1")} />);
    expect(await screen.findByText("spammer@example.test")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Unblock" }));
    await waitFor(() => expect(screen.queryByText("spammer@example.test")).toBeNull());
    expect(screen.getByText("No blocked senders.")).toBeDefined();

    const queued = await listQueuedMutations("acct-1");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({
      type: "unblockSender",
      sender: { scope: "address", value: "spammer@example.test" },
    });
  });

  it("Reset asks for confirmation before calling the API", async () => {
    vi.mocked(gatekeeperApi.fetchGatekeeperStatus).mockResolvedValue(
      status({ gatekeeper: { enabled: true, cutoff: "2026-06-01T00:00:00.000Z" } }),
    );
    vi.mocked(gatekeeperApi.resetGatekeeper).mockResolvedValue(
      mutationStatus({
        gatekeeper: { enabled: true, cutoff: "2026-06-02T00:00:00.000Z" },
        seeded: 3,
      }),
    );

    render(<GatekeeperSection account={makeMailAccount("acct-1")} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reset Gatekeeper" }));
    expect(gatekeeperApi.resetGatekeeper).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    await waitFor(() => expect(gatekeeperApi.resetGatekeeper).toHaveBeenCalledWith("acct-1"));
    expect((await screen.findByRole("status")).textContent).toMatch(/Approved 3 senders/);
  });
});
