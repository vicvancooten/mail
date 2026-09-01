import type { SyncResponse } from "@mail/shared";
import { cleanup, render, screen } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyMailAccountDelta, applyThreadDelta } from "../store/server-writes.js";
import { resetSyncStatus } from "../sync/sync-loop.js";
import { delta, makeMailAccount, makeThread } from "../test-support/mail-fixtures.js";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { MailSection } from "./MailSection.js";

/**
 * The read path end to end: the Local Cache is what the UI renders from, and
 * `POST /sync` only fills it (ADR-0010). Nothing here should ever wait on the
 * network to paint.
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

/** Serves the auth bootstrap normally and hands `POST /sync` to the test. */
function stubFetch(sync: () => Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      const auth = AUTH_RESPONSES[url];
      if (auth) return Promise.resolve(auth());
      if (url === "/sync") return sync();
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

const never = () => new Promise<Response>(() => {});

beforeEach(async () => {
  resetSyncStatus();
  const name = `mail-section-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seedCachedMail(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({ created: [makeThread("t1", "acct-1", { subject: "Last state" })] }),
    { replace: false },
  );
}

function renderMail() {
  render(
    <AuthProvider>
      <MailSection />
    </AuthProvider>,
  );
}

describe("MailSection", () => {
  it("renders last state from the cache while /sync is still in flight", async () => {
    await seedCachedMail();
    stubFetch(never);

    renderMail();

    expect(await screen.findByText("Last state")).toBeDefined();
  });

  it("renders last state when the Sync Backend is unreachable, and says nothing about it", async () => {
    await seedCachedMail();
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    renderMail();

    expect(await screen.findByText("Last state")).toBeDefined();
    // Silent when healthy, and silent about a backend that is merely down:
    // the offline indicator is a separate, deliberate signal.
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it("converges on a cold, empty cache once /sync answers", async () => {
    const responses: SyncResponse[] = [
      {
        user: { MailAccount: delta({ created: [makeMailAccount("acct-1")], newState: "ma-1" }) },
        mailAccounts: {},
      },
      {
        user: {},
        mailAccounts: {
          "acct-1": {
            Thread: delta({
              created: [makeThread("t1", "acct-1", { subject: "Arrived by sync" })],
              newState: "th-1",
            }),
          },
        },
      },
    ];
    stubFetch(() =>
      Promise.resolve(jsonResponse(responses.shift() ?? { user: {}, mailAccounts: {} })),
    );

    renderMail();

    expect(await screen.findByText("Arrived by sync")).toBeDefined();
  });

  it("says where a truncated list ends rather than implying it reached the beginning", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    await applyThreadDelta("acct-1", delta({ created: [makeThread("t1", "acct-1")] }), {
      replace: false,
    });
    await localCache().listWindows.update("acct-1|all", { complete: false });
    stubFetch(never);

    renderMail();

    expect(await screen.findByText("Older mail needs a connection.")).toBeDefined();
  });
});
