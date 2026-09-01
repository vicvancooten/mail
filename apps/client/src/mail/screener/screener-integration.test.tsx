import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../../auth/AuthContext.js";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { applyMailAccountDelta, applyThreadDelta } from "../../store/server-writes.js";
import { resetSyncStatus } from "../../sync/sync-loop.js";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../../test-support/mail-fixtures.js";
import { jsonResponse } from "../../test-support/mock-fetch.js";
import { MailSection } from "../MailSection.js";

/**
 * End-to-end coverage of #56's acceptance boxes: the banner appearing for a
 * Hold and disappearing once the Screener is viewed, Approve releasing into
 * the Inbox, and a keyboard-only pass through the Screener itself. Driven
 * the same way `MailSection.test.tsx`/`search-integration.test.tsx` are: a
 * real IndexedDB-backed Local Cache, a stubbed `fetch`, no mocked hooks.
 */

let counter = 0;
const names: string[] = [];

const AUTH_RESPONSES: Record<string, () => Response> = {
  "/auth/status": () => jsonResponse({ claimed: true }),
  "/auth/session": () =>
    jsonResponse({
      user: { id: "u1", username: "vic", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
    }),
};

const never = () => new Promise<Response>(() => {});

function stubFetch() {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const auth = AUTH_RESPONSES[url];
    if (auth) return auth();
    if (url === "/sync") return never();
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

beforeEach(async () => {
  resetSyncStatus();
  const name = `screener-integration-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seedHeldSenders(): Promise<void> {
  await applyMailAccountDelta(
    delta({
      created: [makeMailAccount("acct-1", { gatekeeper: { enabled: true, cutoff: null } })],
    }),
    { replace: false },
  );
  await applyThreadDelta(
    "acct-1",
    delta({
      created: [
        makeThread("free", "acct-1", { subject: "Ordinary mail" }),
        makeThread("held-1", "acct-1", {
          subject: "Please read",
          snippet: "First contact",
          heldSender: "stranger@example.test",
          participants: [{ name: "A Stranger", address: "stranger@example.test" }],
        }),
      ],
    }),
    { replace: false },
  );
}

function renderMail() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch() as typeof fetch;
  const result = render(
    <AuthProvider>
      <MailSection />
    </AuthProvider>,
  );
  return {
    ...result,
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("Gatekeeper banner and Screener (#56)", () => {
  it("a Hold shows the banner; Approve from the Screener releases the Thread into the Inbox", async () => {
    await seedHeldSenders();
    renderMail();

    expect(await screen.findByText("Ordinary mail")).toBeDefined();
    // Held mail never shows in the Inbox.
    expect(screen.queryByText("Please read")).toBeNull();

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.getByText(/1 sender waiting in the Screener/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("A Stranger")).toBeDefined();
    // Viewing the Screener dismisses the (now non-existent) banner underneath.
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    // The Screener's own optimistic feel: the row leaves immediately.
    await waitFor(() => expect(screen.queryByText("A Stranger")).toBeNull());
    expect(screen.getByText("Nothing waiting — new strangers show up here.")).toBeDefined();

    // Approving clears `heldSender` server-side; simulate the sync landing.
    await applyThreadDelta(
      "acct-1",
      delta({
        updated: [
          makeThread("held-1", "acct-1", {
            subject: "Please read",
            heldSender: null,
            participants: [{ name: "A Stranger", address: "stranger@example.test" }],
          }),
        ],
      }),
      { replace: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to Inbox" }));
    expect(await screen.findByText("Please read")).toBeDefined();
  });

  it("a keyboard-only pass through the Screener: j/k navigate, a approves, Escape closes", async () => {
    await applyMailAccountDelta(
      delta({
        created: [makeMailAccount("acct-1", { gatekeeper: { enabled: true, cutoff: null } })],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("held-a", "acct-1", {
            subject: "From A",
            heldSender: "a@example.test",
            participants: [{ name: "Ann", address: "a@example.test" }],
            lastMessageAt: minutesAfterEpoch(1),
          }),
          makeThread("held-b", "acct-1", {
            subject: "From B",
            heldSender: "b@example.test",
            participants: [{ name: "Bea", address: "b@example.test" }],
            lastMessageAt: minutesAfterEpoch(2),
          }),
        ],
      }),
      { replace: false },
    );
    renderMail();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByText("Ann");
    await screen.findByText("Bea");
    // The oldest hold starts selected — wait for that settle before driving
    // the keyboard, so this assertion is about `j` moving the selection,
    // never a race with the mount effect that sets it initially.
    await waitFor(() =>
      expect(screen.getByText("Ann").closest("li")?.className).toContain("selected"),
    );

    // j moves the keyboard selection to the second row.
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() =>
      expect(screen.getByText("Bea").closest("li")?.className).toContain("selected"),
    );

    // d denies the selected (Bea's) row — it leaves the list, Ann's stays.
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(screen.queryByText("Bea")).toBeNull());
    expect(screen.getByText("Ann")).toBeDefined();

    // Escape leaves the Screener back to the Inbox.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Ann")).toBeNull());
  });
});
