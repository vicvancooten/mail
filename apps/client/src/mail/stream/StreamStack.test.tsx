import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../auth/AuthContext.js";
import { Toaster } from "../../components/ui/sonner.js";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { listQueuedMutations } from "../../store/mutation-queue.js";
import { applyMailAccountDelta, applyThreadDelta } from "../../store/server-writes.js";
import { resetSyncStatus } from "../../sync/sync-loop.js";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../../test-support/mail-fixtures.js";
import { jsonResponse } from "../../test-support/mock-fetch.js";
import { StreamStack } from "./StreamStack.js";

/** The composer's own network calls — irrelevant here and mocked quiet, same as `MailSection.test.tsx`. */
vi.mock("../../api/attachments.js", () => ({
  fetchComposeConfig: vi.fn(async () => ({ attachmentBudgetEncodedBytes: 25 * 1024 * 1024 })),
  uploadAttachment: vi.fn(() => new Promise(() => {})),
  deleteAttachment: vi.fn(async () => {}),
  attachmentUrl: (compositionId: string, attachmentId: string) =>
    `/compositions/${compositionId}/attachments/${attachmentId}`,
  AttachmentBudgetExceededError: class AttachmentBudgetExceededError extends Error {},
}));

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

function stubFetch(sync: () => Promise<Response> = never) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = AUTH_RESPONSES[url];
      if (auth) return Promise.resolve(auth());
      if (url === "/sync") return sync();
      if (url.includes("/messages")) return Promise.resolve(jsonResponse({ messages: [] }));
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(async () => {
  resetSyncStatus();
  const name = `stream-stack-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.clear();
  stubFetch();
});

afterEach(async () => {
  cleanup();
  toast.dismiss();
  vi.unstubAllGlobals();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/** Two Inbox Threads, newest first: "Newer thread" then "Older thread". */
async function seedTwoThreads(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({
      created: [
        makeThread("t-older", "acct-1", {
          subject: "Older thread",
          lastMessageAt: minutesAfterEpoch(1),
        }),
        makeThread("t-newer", "acct-1", {
          subject: "Newer thread",
          lastMessageAt: minutesAfterEpoch(2),
        }),
      ],
    }),
    { replace: false },
  );
}

function renderStream(onLeave: () => void = () => {}) {
  return render(
    <AuthProvider>
      <StreamStack onLeave={onLeave} />
      <Toaster />
    </AuthProvider>,
  );
}

describe("StreamStack (#105)", () => {
  it("shows the newest Inbox Thread as a card, with the next one peeking behind", async () => {
    await seedTwoThreads();
    renderStream();

    expect(await screen.findByText("Newer thread")).toBeDefined();
    expect(screen.getByText("Older thread")).toBeDefined();
    expect(screen.queryByText("Snippet t-older")).toBeNull();
  });

  it("'e' Dones the top card and the next one slides up", async () => {
    await seedTwoThreads();
    renderStream();
    await screen.findByText("Newer thread");

    act(() => {
      fireEvent.keyDown(window, { key: "e" });
    });

    await waitFor(async () => {
      expect(await listQueuedMutations("acct-1")).toEqual([
        expect.objectContaining({
          intent: expect.objectContaining({ type: "archive", threadId: "t-newer" }),
        }),
      ]);
    });

    await waitFor(() => {
      expect(screen.queryByText("Newer thread")).toBeNull();
    });
    expect(await screen.findByText("Older thread")).toBeDefined();
  });

  it("Skip moves the stack on without any Triage call", async () => {
    await seedTwoThreads();
    renderStream();
    await screen.findByText("Newer thread");

    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));

    await waitFor(() => {
      expect(screen.queryByText("Newer thread")).toBeNull();
    });
    expect(await screen.findByText("Older thread")).toBeDefined();
    expect(await listQueuedMutations("acct-1")).toEqual([]);
  });

  it("reaches an ending state once the stack is cleared, with a way back to Mail", async () => {
    await seedTwoThreads();
    const onLeave = vi.fn();
    renderStream(onLeave);
    await screen.findByText("Newer thread");

    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    // Waits for the top card itself, not just its peek showing through
    // early (the peek names the next Thread the instant the leave starts).
    await waitFor(() => {
      expect(document.querySelector(".reading-subject")?.textContent).toBe("Older thread");
    });
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));

    expect(await screen.findByText("Stream cleared")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Back to Mail" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("Esc leaves Stream without changing anything", async () => {
    await seedTwoThreads();
    const onLeave = vi.fn();
    renderStream(onLeave);
    await screen.findByText("Newer thread");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onLeave).toHaveBeenCalledOnce();
    expect(await listQueuedMutations("acct-1")).toEqual([]);
  });
});
