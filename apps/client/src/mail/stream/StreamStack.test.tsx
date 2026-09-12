import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { PaletteHostTestProvider } from "../../test-support/palette-host-harness.js";
import { resetActiveMailHost } from "../actions/active-mail-host.js";
import { resetSurfaceHandles } from "../actions/surface-handles.js";
import { resetUndoToastsForTest } from "../undo-toast.js";
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
  resetUndoToastsForTest();
  // `active-mail-host.ts`/`surface-handles.ts` (#147): dropped on unmount by
  // the mounted surface itself, but only once that unmount's own effect
  // cleanup actually runs — their own reset exports are the guaranteed way
  // to start each test with neither still holding a previous mount's host.
  resetActiveMailHost();
  resetSurfaceHandles();
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

function renderStream(onLeave: () => void = () => {}, onNoteCreated?: (noteId: string) => void) {
  return render(
    <AuthProvider>
      <PaletteHostTestProvider>
        <StreamStack onLeave={onLeave} onNoteCreated={onNoteCreated} />
      </PaletteHostTestProvider>
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

  it("renders the same Reader action bar Split/List do, plus its own Skip button (#289, #105: 'Stream is not a second design')", async () => {
    await seedTwoThreads();
    renderStream();
    await screen.findByText("Newer thread");

    // The Reply and Mail groups' own inline runs — same as every surface.
    expect(screen.getByRole("button", { name: "Reply" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Done — archive this thread" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Snooze" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeDefined();

    // Skip stays Stream's own button, not a registry group.
    expect(screen.getByRole("button", { name: /Skip/ })).toBeDefined();

    // Pin, Star, Label, Read/unread and Forward all reach through the Mail
    // group's overflow (#289) — same on Stream as on Split/List.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /More actions for "Newer/ }));
    expect(await screen.findByRole("menuitem", { name: /Pin/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Star/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Mark as unread" })).toBeDefined();
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

  it("swiping the card right commits Done, through the same Triage/Undo path as 'e' (#149)", async () => {
    await seedTwoThreads();
    renderStream();
    await screen.findByText("Newer thread");

    const surface = document.querySelector(".stream-card-swipe-surface") as Element;
    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(surface, { pointerId: 1, pointerType: "touch", clientX: 120 });
    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: "touch", clientX: 120 });

    await waitFor(async () => {
      expect(await listQueuedMutations("acct-1")).toEqual([
        expect.objectContaining({
          intent: expect.objectContaining({ type: "archive", threadId: "t-newer" }),
        }),
      ]);
    });
    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    expect(await screen.findByText("Older thread")).toBeDefined();
    // "Done" collides with the card's own (hidden) swipe-reveal label — the
    // Undo button is the toast's unambiguous signature (#95, ADR-0019).
    expect(await screen.findByRole("button", { name: "Undo" })).toBeDefined();
  });

  it("swiping the card left commits Trash, past the threshold (#149)", async () => {
    await seedTwoThreads();
    renderStream();
    await screen.findByText("Newer thread");

    const surface = document.querySelector(".stream-card-swipe-surface") as Element;
    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(surface, { pointerId: 1, pointerType: "touch", clientX: -120 });
    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: "touch", clientX: -120 });

    await waitFor(async () => {
      expect(await listQueuedMutations("acct-1")).toEqual([
        expect.objectContaining({
          intent: expect.objectContaining({ type: "trash", threadId: "t-newer" }),
        }),
      ]);
    });
    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    expect(await screen.findByText("Moved to trash")).toBeDefined();
  });

  it("releasing a card swipe short of the threshold cancels, leaving the stack untouched (#149)", async () => {
    await seedTwoThreads();
    renderStream();
    await screen.findByText("Newer thread");

    const surface = document.querySelector(".stream-card-swipe-surface") as Element;
    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(surface, { pointerId: 1, pointerType: "touch", clientX: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1, pointerType: "touch", clientX: 40 });

    await waitFor(() => expect(listQueuedMutations("acct-1")).resolves.toEqual([]));
    expect(screen.getByText("Newer thread")).toBeDefined();
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

  it('"Save to Notes" (#195, #289) works from the top card, the same real wiring Mail\'s own reader gets — not a stub', async () => {
    await seedTwoThreads();
    const onNoteCreated = vi.fn();
    renderStream(() => {}, onNoteCreated);
    await screen.findByText("Newer thread");

    // Integrations (#289): reachable only through the Reader's own
    // "Send to…" menu now — a real pointer-event sequence to open it, same
    // as every other Radix Dropdown trigger in this suite.
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Send "Newer thread" to…/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save to Notes" }));

    await waitFor(() => expect(onNoteCreated).toHaveBeenCalledOnce());
    expect(await screen.findByText("Added to Notes")).toBeDefined();
  });
});
