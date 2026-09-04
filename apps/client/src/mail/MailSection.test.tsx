import type { SyncResponse } from "@mail/shared";
import { labelId } from "@mail/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Dexie from "dexie";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { Toaster } from "../components/ui/sonner.js";
import { publishNotificationTarget } from "../pwa/notification-router.js";
import { EMPTY_COMPOSE_CONTENT, saveComposition } from "../store/compositions.js";
import { enqueueUserMutation } from "../store/index.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { listQueuedMutations, resolveMutationOutcomes } from "../store/mutation-queue.js";
import {
  applyLabelDelta,
  applyMailAccountDelta,
  applyThreadDelta,
} from "../store/server-writes.js";
import { resetSyncStatus } from "../sync/sync-loop.js";
import {
  delta,
  makeLabel,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { writeViewMode } from "./device-preferences.js";
import { MailSection } from "./MailSection.js";

/** The composer's own network calls (`Attachments.tsx`) — irrelevant here and mocked quiet, same as `Composer.test.tsx`. */
vi.mock("../api/attachments.js", () => ({
  fetchComposeConfig: vi.fn(async () => ({ attachmentBudgetEncodedBytes: 25 * 1024 * 1024 })),
  uploadAttachment: vi.fn(() => new Promise(() => {})),
  deleteAttachment: vi.fn(async () => {}),
  attachmentUrl: (compositionId: string, attachmentId: string) =>
    `/compositions/${compositionId}/attachments/${attachmentId}`,
  AttachmentBudgetExceededError: class AttachmentBudgetExceededError extends Error {},
}));

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
  // View mode / last account are Device Preferences stored in `localStorage`
  // (device-preferences.ts) — never leak one test's choice into the next.
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  // Sonner's toast store is a module-level singleton, outside React — it
  // outlives `cleanup()`'s unmount, so a toast left over from one test
  // (its dismiss timer not yet due) would otherwise bleed into the next.
  toast.dismiss();
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

/** Two Threads, newest first: "Newer thread" (unread) then "Older thread" (read) — #42's keyboard tests. */
async function seedTwoThreads(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({
      created: [
        makeThread("t-older", "acct-1", {
          subject: "Older thread",
          unreadCount: 0,
          lastMessageAt: minutesAfterEpoch(1),
        }),
        makeThread("t-newer", "acct-1", {
          subject: "Newer thread",
          unreadCount: 1,
          messageCount: 1,
          lastMessageAt: minutesAfterEpoch(2),
        }),
      ],
    }),
    { replace: false },
  );
}

function renderMail(props: Partial<Parameters<typeof MailSection>[0]> = {}) {
  return render(
    <AuthProvider>
      <MailSection {...props} />
      <Toaster />
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

  it("opens a Thread into the reading pane straight from the cache, no network wait", async () => {
    await seedCachedMail();
    stubFetch(never);

    renderMail();

    const row = await screen.findByText("Last state");
    fireEvent.click(row);

    // The detail pane's own copy of the Thread (the Snippet, since #41
    // owns the real body) appears instantly — `stubFetch(never)` means
    // nothing here can have come from a network round trip. Scoped to
    // `.thread-detail` because the row itself also shows the Snippet.
    const detail = await screen.findByText("Last state", { selector: ".reading-subject" });
    expect(detail.closest(".thread-detail")?.textContent).toContain("Snippet t1");
  });

  it("switches between Split and List view, and remembers the choice across a remount", async () => {
    await seedCachedMail();
    stubFetch(never);

    const { unmount } = renderMail();
    expect(await screen.findByText("Last state")).toBeDefined();

    // Split view: list and reading pane both present at once.
    expect(document.querySelector(".split-view")).not.toBeNull();

    // View mode is a reactive Device Preference now (#99,
    // `device-preferences.ts#useViewMode`), set from Settings' "This
    // device" page (`ThisDeviceSection.test.tsx` covers that control) — this
    // test exercises the storage-level write MailSection subscribes to,
    // same as a write from that other surface would.
    act(() => writeViewMode("list"));
    expect(document.querySelector(".split-view")).toBeNull();

    // List view: opening a Thread swaps the list for a full-screen detail,
    // with a way back rather than sitting beside it.
    fireEvent.click(screen.getByText("Last state"));
    expect(await screen.findByRole("button", { name: "Back to list" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
    expect(await screen.findByText("Last state")).toBeDefined();

    unmount();
    cleanup();
    renderMail();

    await screen.findByText("Last state");
    expect(document.querySelector(".split-view")).toBeNull();
  });

  it("Stream's own entry point (#105) is a plain navigation, not a view-mode toggle", async () => {
    await seedCachedMail();
    stubFetch(never);
    const onOpenStream = vi.fn();

    renderMail({ onOpenStream });
    await screen.findByText("Last state");

    fireEvent.click(screen.getByRole("button", { name: "Open Stream" }));

    // Unlike the retired Stream mode toggle, this never swaps what Mail is
    // showing — it hands off to whoever owns navigation (`router/MailRoute.tsx`
    // in production), landing on Stream's own route.
    expect(onOpenStream).toHaveBeenCalledOnce();
    expect(document.querySelector(".split-view")).not.toBeNull();
  });

  it("Account Scope defaults to all accounts, merged newest-first (#73)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { subject: "Account one thread" })] }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-2",
      delta({ created: [makeThread("t2", "acct-2", { subject: "Account two thread" })] }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();

    // Nothing narrowed yet — both accounts' Threads are in Scope.
    expect(await screen.findByText("Account one thread")).toBeDefined();
    expect(await screen.findByText("Account two thread")).toBeDefined();

    // Opens the Account Scope control and unchecks acct-1 — narrows the
    // Thread list to only the Mail Account still checked.
    fireEvent.click(screen.getByRole("button", { name: /Account Scope: All accounts/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "acct-1@example.test" }));

    await waitFor(() => expect(screen.queryByText("Account one thread")).toBeNull());
    expect(screen.getByText("Account two thread")).toBeDefined();
  });

  it("Account Scope cannot be narrowed to nothing (#73)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    // Account Scope resolves (defaulting to all) a render or two after the
    // Mail Account list itself does — wait for that resolved accessible
    // name rather than the (already-present) search field, or the click
    // below can land while Scope still reads empty.
    const scopeButton = await screen.findByRole("button", { name: /Account Scope: All accounts/ });
    fireEvent.click(scopeButton);
    fireEvent.click(screen.getByRole("checkbox", { name: "acct-1@example.test" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "acct-2@example.test" }));

    // The second uncheck would empty Scope — it stays checked.
    expect(screen.getByRole("checkbox", { name: "acct-2@example.test" })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("a notification click on another account's Thread narrows Scope to it and opens it (#53, #73)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { subject: "Account one thread" })] }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-2",
      delta({ created: [makeThread("t2", "acct-2", { subject: "Account two thread" })] }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    expect(await screen.findByText("Account one thread")).toBeDefined();

    act(() => {
      publishNotificationTarget({ kind: "thread", mailAccountId: "acct-2", threadId: "t2" });
    });

    expect(
      await screen.findByText("Account two thread", { selector: ".reading-subject" }),
    ).toBeDefined();

    // The primary account (compose/Screener/search's own single-account
    // context) follows the notification: Scope narrows to just the target.
    fireEvent.click(screen.getByRole("button", { name: /Account Scope/ }));
    expect(screen.getByRole("checkbox", { name: "acct-2@example.test" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("checkbox", { name: "acct-1@example.test" })).toHaveProperty(
      "checked",
      false,
    );
  });

  it("a notification click on a failed send narrows Scope to it and reopens its Composition (#53, #73)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    await saveComposition(
      "comp-failed",
      "acct-2",
      { ...EMPTY_COMPOSE_CONTENT, subject: "Re: quarterly numbers" },
      { force: true },
    );
    stubFetch(never);

    renderMail();
    // Same "wait for Scope itself to resolve" reasoning as the test above.
    await screen.findByRole("button", { name: /Account Scope: All accounts/ });

    act(() => {
      publishNotificationTarget({
        kind: "failed-send",
        mailAccountId: "acct-2",
        compositionId: "comp-failed",
      });
    });

    const subject = (await screen.findByPlaceholderText("Subject")) as HTMLInputElement;
    await waitFor(() => expect(subject.value).toBe("Re: quarterly numbers"));

    fireEvent.click(screen.getByRole("button", { name: /Account Scope/ }));
    expect(screen.getByRole("checkbox", { name: "acct-2@example.test" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("checkbox", { name: "acct-1@example.test" })).toHaveProperty(
      "checked",
      false,
    );
  });

  it("a full keyboard-only pass: navigate, archive, star, and auto-advance (#42)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    // j with nothing selected opens the newest Thread.
    fireEvent.keyDown(window, { key: "j" });
    expect(
      (await screen.findByRole("option", { name: /Newer thread/ })).getAttribute("aria-selected"),
    ).toBe("true");

    // j again moves to (and opens) the next-older Thread; k moves back.
    fireEvent.keyDown(window, { key: "j" });
    expect(
      (await screen.findByRole("option", { name: /Older thread/ })).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(window, { key: "k" });
    expect(
      (await screen.findByRole("option", { name: /Newer thread/ })).getAttribute("aria-selected"),
    ).toBe("true");

    // s stars the open Thread.
    expect(screen.getByRole("button", { name: "Star" })).toBeDefined();
    fireEvent.keyDown(window, { key: "s" });
    expect(await screen.findByRole("button", { name: "Unstar" })).toBeDefined();

    // e archives the open Thread: it's gone from the list, and — direction
    // defaults to "older" — the next-older Thread takes over the selection.
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    expect(
      (await screen.findByRole("option", { name: /Older thread/ })).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("the row's Done control marks it Done from the pointer, without selecting the row (#75)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    fireEvent.click(screen.getByRole("button", { name: /Mark "Newer thread" Done/ }));

    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    expect(screen.getByText("Older thread")).toBeDefined();
    // Never opened into the reading pane — Done is an action, not a selection.
    expect(document.querySelector(".thread-detail")).toBeNull();
  });

  it("a rollback returns the row Done put down, and raises a toast naming the failure (#75)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    fireEvent.click(screen.getByRole("button", { name: /Mark "Newer thread" Done/ }));
    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());

    // Simulate the Sync Backend rejecting the queued archive — the same
    // seam `RollbackToast.test.tsx` drives directly.
    const queued = await listQueuedMutations("acct-1");
    await act(async () => {
      await resolveMutationOutcomes(
        "acct-1",
        queued,
        queued.map((mutation) => ({ id: mutation.id, status: "rejected", reason: "server_error" })),
      );
    });

    expect(await screen.findByText("Newer thread")).toBeDefined();
    expect(await screen.findByText("Couldn't archive — restored to the list.")).toBeDefined();
  });

  it("selecting an unread Thread marks it read; the Mark unread button toggles it back (#42)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    const row = await screen.findByRole("option", { name: /Newer thread/ });
    expect(row.className).toContain("unread");

    fireEvent.click(row);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Newer thread/ }).className).not.toContain(
        "unread",
      );
    });
    const markUnread = await screen.findByRole("button", { name: "Mark unread" });

    // `u` no longer toggles read/unread (#79 rebinds it to "back to list") —
    // the mouse affordance is still the way to reach it, plus the Command
    // Palette now (`command-palette.test.tsx`).
    fireEvent.click(markUnread);
    expect(await screen.findByRole("button", { name: "Mark read" })).toBeDefined();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Newer thread/ }).className).toContain("unread");
    });
  });

  it("u (#79, rebound from mark-unread) sends the reading pane back to the list", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    const row = await screen.findByRole("option", { name: /Newer thread/ });
    fireEvent.click(row);
    await screen.findByText("Newer thread", { selector: ".reading-subject" });

    fireEvent.keyDown(window, { key: "u" });

    // Split view: "back to list" clears the selection — the reading pane's
    // own empty state, not a route change.
    await waitFor(() => expect(screen.getByText("Nothing open")).toBeDefined());
  });

  it("the auto-advance direction preference flips trash's neighbor choice", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");
    // The direction toggle moved into Settings' General page (#99,
    // `GeneralSection.test.tsx` covers that control) — it writes the same
    // synced `Preference` mutation this exercises directly, the way
    // `usePreference`'s `base ⊕ pending` overlay picks it up instantly
    // regardless of which surface enqueued it.
    await act(() =>
      enqueueUserMutation({ type: "setAutoAdvance", enabled: true, direction: "newer" }),
    );

    // Open the *older* Thread and trash it — with direction flipped to
    // "newer", the newer Thread (the only remaining neighbor either way
    // here) still takes over, but exercised via the actual toggle rather
    // than the default.
    fireEvent.click(screen.getByText("Older thread"));
    fireEvent.keyDown(window, { key: "#" });
    await waitFor(() => expect(screen.queryByText("Older thread")).toBeNull());
    expect(
      (await screen.findByRole("option", { name: /Newer thread/ })).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("p pins the open Thread, and it surfaces first in the list regardless of date (#43)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    // Open the older (and by date, second) Thread.
    fireEvent.click(await screen.findByText("Older thread"));
    expect(screen.getByRole("button", { name: "Pin" })).toBeDefined();

    fireEvent.keyDown(window, { key: "p" });
    expect(await screen.findByRole("button", { name: "Unpin" })).toBeDefined();

    // Pinned floats to the top of the list, ahead of the newer, unpinned Thread.
    const rows = await screen.findAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Older thread"),
      expect.stringContaining("Newer thread"),
    ]);
    // Scoped to the list itself (#74's own sidebar has a "Pinned" nav entry too).
    expect(within(screen.getByRole("listbox")).getByText("Pinned")).toBeDefined(); // the synthetic group header
  });

  it("snoozing a Thread from the row cluster removes it from the Inbox instantly and it appears in Snoozed (#76)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    fireEvent.click(screen.getByRole("button", { name: /Snooze "Newer thread"/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Later today" }));

    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    expect(screen.getByText("Older thread")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Snoozed" }));
    expect(await screen.findByText("Newer thread")).toBeDefined();
  });

  it("a rollback returns the row Snooze put down, and raises a toast naming the failure (#76)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    fireEvent.click(screen.getByRole("button", { name: /Snooze "Newer thread"/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Later today" }));
    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());

    const queued = await listQueuedMutations("acct-1");
    await act(async () => {
      await resolveMutationOutcomes(
        "acct-1",
        queued,
        queued.map((mutation) => ({ id: mutation.id, status: "rejected", reason: "server_error" })),
      );
    });

    expect(await screen.findByText("Newer thread")).toBeDefined();
    expect(await screen.findByText("Couldn't snooze — restored to the list.")).toBeDefined();
  });

  it("right-clicking a row opens the Action registry's menu, and Trash — which has no row control at all — works from it (#94)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    const row = await screen.findByRole("option", { name: /Newer thread/ });

    fireEvent.contextMenu(row);

    // The menu names the Thread it is about, and lists Trash with its own
    // keycap — the action #66 deliberately gave no hover or swipe control,
    // which on touch makes this menu the only way to reach it.
    const trash = await screen.findByRole("menuitem", { name: /Move to Trash/ });
    expect(trash.textContent).toContain("#");
    fireEvent.click(trash);

    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
  });

  it("a row's menu acts on the row it was raised on, not on whatever is selected (#94)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    // Open the *newer* Thread, then raise the older row's own menu.
    fireEvent.click(await screen.findByText("Newer thread"));
    fireEvent.contextMenu(await screen.findByRole("option", { name: /Older thread/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Mark Done/ }));

    await waitFor(() => expect(screen.queryByText("Older thread")).toBeNull());
    expect(screen.getByRole("option", { name: /Newer thread/ })).toBeDefined();
  });
});

describe("Sidebar (#74)", () => {
  it("Archive shows only Threads real archived Threads, hiding the ordinary Inbox", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t-inbox", "acct-1", { subject: "Inbox thread" }),
          makeThread("t-archived", "acct-1", {
            subject: "Archived thread",
            inInbox: false,
            folderRole: "archive",
          }),
        ],
      }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    await screen.findByText("Inbox thread");
    expect(screen.queryByText("Archived thread")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(await screen.findByText("Archived thread")).toBeDefined();
    expect(screen.queryByText("Inbox thread")).toBeNull();
  });

  it("Snoozed lists what is waiting, hiding the ordinary Inbox (#76)", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t-inbox", "acct-1", { subject: "Inbox thread" }),
          makeThread("t-snoozed", "acct-1", {
            subject: "Snoozed thread",
            inInbox: false,
            snoozeUntil: "2026-07-01T08:00:00.000Z",
          }),
        ],
      }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    await screen.findByText("Inbox thread");
    expect(screen.queryByText("Snoozed thread")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Snoozed" }));

    expect(await screen.findByText("Snoozed thread")).toBeDefined();
    expect(screen.queryByText("Inbox thread")).toBeNull();
  });

  it("Screener opens from its sidebar entry, same as the Gatekeeper banner's own button", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    fireEvent.click(screen.getByRole("button", { name: "Screener" }));

    expect(await screen.findByRole("region", { name: "Screener" })).toBeDefined();
    expect(screen.queryByText("Newer thread")).toBeNull();
  });
});

describe("MailSection", () => {
  it("lists a synced Label in the filter-by-label picker, hidden entirely when there are none", async () => {
    await seedTwoThreads();
    stubFetch(never);

    const { unmount } = renderMail();
    await screen.findByText("Newer thread");
    // No Labels synced yet — the picker doesn't show at all.
    expect(screen.queryByLabelText("Filter by label")).toBeNull();
    unmount();
    cleanup();

    await applyLabelDelta(
      "acct-1",
      delta({ created: [makeLabel(labelId("acct-1", "Work"), "acct-1", { name: "Work" })] }),
      { replace: false },
    );
    renderMail();
    await screen.findByText("Newer thread");
    const filter = await screen.findByLabelText<HTMLSelectElement>("Filter by label");
    expect(screen.getByRole("option", { name: "Work" })).toBeDefined();
    expect(filter.value).toBe(""); // "All mail" by default
  });

  it("applies and removes a Label from the keyboard, and the filter-by-label view narrows the corpus (#43)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.click(await screen.findByText("Newer thread"));

    // L opens the picker; typing a new name and submitting applies it —
    // offline, before any server round trip (`stubFetch(never)`).
    fireEvent.keyDown(window, { key: "L" });
    const input = await screen.findByLabelText("New label name");
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const detail = document.querySelector(".thread-detail") as HTMLElement;
    expect(await within(detail).findByText("Work", { selector: ".label-chip" })).toBeDefined();

    // The filter-by-label picker in the top bar already lists it (derived
    // from the Thread's own overlay, not a round trip through the `Label`
    // collection) and filtering to it narrows the corpus.
    const filter = await screen.findByLabelText<HTMLSelectElement>("Filter by label");
    expect(screen.getByRole("option", { name: "Work" })).toBeDefined();
    fireEvent.change(filter, { target: { value: labelId("acct-1", "Work") } });
    await waitFor(() => expect(screen.queryByText("Older thread")).toBeNull());
    expect(screen.getByText("Newer thread")).toBeDefined();

    // Back to "All mail" (switching the filter clears the selection) and
    // reopen the Thread so its detail pane stays reachable once the Label
    // currently filtering it to view is removed.
    fireEvent.change(filter, { target: { value: "" } });
    fireEvent.click(await screen.findByText("Newer thread"));
    const reopenedDetail = document.querySelector(".thread-detail") as HTMLElement;

    // Removing it from the keyboard drops the chip immediately.
    fireEvent.keyDown(window, { key: "L" });
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Work/ }));
    await waitFor(() =>
      expect(within(reopenedDetail).queryByText("Work", { selector: ".label-chip" })).toBeNull(),
    );
  });

  /**
   * "One composer at a time" (compose-spec §Composer surface & keys): a
   * second Compose click while a composer is already open must not swap
   * `composeId` out from under it — that would unmount the live `Composer`
   * with no synchronous flush of whatever's still sitting in its autosave
   * debounce.
   */
  it("does not drop unsaved typing when Compose is clicked again while a composer is already open", async () => {
    await seedCachedMail();
    stubFetch(never);
    renderMail();

    const composeButton = await screen.findByRole("button", { name: "Compose" });
    fireEvent.click(composeButton);

    const subject = await screen.findByPlaceholderText("Subject");
    fireEvent.change(subject, { target: { value: "Do not lose this" } });

    fireEvent.click(composeButton);

    const stillOpen = await screen.findByPlaceholderText("Subject");
    expect(stillOpen).toBe(subject); // the same input — the composer was never unmounted
    expect((stillOpen as HTMLInputElement).value).toBe("Do not lose this");
  });
});

describe("MailSection — the group header cluster (#66, #67, #77)", () => {
  /** An hour ago, real wall-clock, but never earlier than midnight — so the
   * Thread lands in the "Today" group regardless of when this suite runs. A
   * bare "now minus an hour" put it in *Yesterday* between 00:00 and 01:00
   * local, which made these tests fail for one hour a day. */
  function earlierToday(): string {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return new Date(Math.max(Date.now() - 60 * 60 * 1000, midnight.getTime())).toISOString();
  }

  async function seedTodayThreads(): Promise<void> {
    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), {
      replace: false,
    });
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t-a", "acct-1", { subject: "Thread A", lastMessageAt: earlierToday() }),
          makeThread("t-b", "acct-1", { subject: "Thread B", lastMessageAt: earlierToday() }),
        ],
      }),
      { replace: false },
    );
  }

  /** `stubFetch`'s auth/sync routing, plus the three `/bulk-triage/*` endpoints (#67). */
  function stubFetchWithBulkTriage(options: {
    sync?: () => Promise<Response>;
    batch?: (body: Record<string, unknown>) => Response;
    count?: () => Response;
    undo?: (body: Record<string, unknown>) => Response;
  }) {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = init?.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : undefined;
        calls.push({ url, body });
        const auth = AUTH_RESPONSES[url];
        if (auth) return Promise.resolve(auth());
        if (url === "/sync") return (options.sync ?? never)();
        if (url === "/bulk-triage/count") {
          return Promise.resolve((options.count ?? (() => jsonResponse({ count: 0 })))());
        }
        if (url === "/bulk-triage/batch") {
          const respond =
            options.batch ??
            (() => jsonResponse({ batchId: "batch-1", affectedCount: 0, accounts: [] }));
          return Promise.resolve(respond(body ?? {}));
        }
        if (url === "/bulk-triage/undo") {
          const respond =
            options.undo ?? (() => jsonResponse({ status: "undone", affectedCount: 0 }));
          return Promise.resolve(respond(body ?? {}));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    return calls;
  }

  it("Done all sends a date-range/folder/Scope target with no thread-id list, and true-count-carrying, ~10s Undo toast", async () => {
    await seedTodayThreads();
    const calls = stubFetchWithBulkTriage({
      batch: () =>
        jsonResponse({
          batchId: "batch-1",
          // The true total (5) exceeds what's loaded (2) — #67's "a group can
          // hold thousands the Client never loaded" made concrete.
          affectedCount: 5,
          accounts: [{ mailAccountId: "acct-1", status: "applied", affectedCount: 5 }],
        }),
    });

    renderMail();
    await screen.findByText("Thread A");

    fireEvent.click(await screen.findByRole("button", { name: "Done with Today" }));

    await waitFor(() => {
      const batchCall = calls.find((call) => call.url === "/bulk-triage/batch");
      expect(batchCall).toBeDefined();
      const body = batchCall?.body as { action: string; target: Record<string, unknown> };
      expect(body.action).toBe("done");
      expect(body.target).toEqual({
        accountScope: ["acct-1"],
        folderRole: "inbox",
        since: expect.any(String),
        until: null, // Today is open-ended — a Thread arriving after the request still lands in it (#67).
      });
      expect(body.target.threadIds).toBeUndefined();
    });

    // Both loaded Threads leave the list once their stagger/collapse finishes.
    await waitFor(() => expect(screen.queryByText("Thread A")).toBeNull(), { timeout: 2000 });
    expect(screen.queryByText("Thread B")).toBeNull();

    // The toast names the true total, not the two that were actually loaded.
    expect(await screen.findByText(/Done: 5 in Today\./)).toBeDefined();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDefined();
  });

  it("Undo restores the group and re-syncs", async () => {
    await seedTodayThreads();
    const calls = stubFetchWithBulkTriage({
      // Resolves immediately (rather than the default never-resolving stub)
      // so a later `requestSyncNow()` round can actually fire a second
      // `/sync` call instead of piling up behind a permanently in-flight one.
      sync: () => Promise.resolve(jsonResponse({ user: {}, mailAccounts: {} })),
      batch: () =>
        jsonResponse({
          batchId: "batch-1",
          affectedCount: 2,
          accounts: [{ mailAccountId: "acct-1", status: "applied", affectedCount: 2 }],
        }),
      undo: () => jsonResponse({ status: "undone", affectedCount: 2 }),
    });

    renderMail();
    await screen.findByText("Thread A");
    fireEvent.click(await screen.findByRole("button", { name: "Done with Today" }));
    await waitFor(() => expect(screen.queryByText("Thread A")).toBeNull(), { timeout: 2000 });

    const syncCallsBeforeUndo = calls.filter((call) => call.url === "/sync").length;
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(screen.getByText("Thread A")).toBeDefined());
    expect(screen.getByText("Thread B")).toBeDefined();
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/sync").length).toBeGreaterThan(
        syncCallsBeforeUndo,
      ),
    );
    expect(calls.some((call) => call.url === "/bulk-triage/undo")).toBe(true);
  });

  it("Mark all read sends the markRead action and never hides a Thread", async () => {
    await seedTodayThreads();
    const calls = stubFetchWithBulkTriage({
      batch: () =>
        jsonResponse({
          batchId: "batch-1",
          affectedCount: 2,
          accounts: [{ mailAccountId: "acct-1", status: "applied", affectedCount: 2 }],
        }),
    });

    renderMail();
    await screen.findByText("Thread A");
    fireEvent.click(await screen.findByRole("button", { name: "Mark Today read" }));

    await waitFor(() => {
      const batchCall = calls.find((call) => call.url === "/bulk-triage/batch");
      expect((batchCall?.body as { action: string })?.action).toBe("markRead");
    });
    // Marking read never removes a row from the list.
    expect(screen.getByText("Thread A")).toBeDefined();
    expect(screen.getByText("Thread B")).toBeDefined();
  });

  it("right-clicking the Time Group header offers the same three actions its cluster does (#94)", async () => {
    await seedTodayThreads();
    const calls = stubFetchWithBulkTriage({
      batch: () =>
        jsonResponse({
          batchId: "batch-1",
          affectedCount: 2,
          accounts: [{ mailAccountId: "acct-1", status: "applied", affectedCount: 2 }],
        }),
    });

    renderMail();
    await screen.findByText("Thread A");

    const header = within(screen.getByRole("listbox")).getByText("Today");
    fireEvent.contextMenu(header);

    expect(await screen.findByRole("menuitem", { name: "Mark Today read" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Collapse group/ })).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: "Done with Today" }));

    await waitFor(() => {
      const batchCall = calls.find((call) => call.url === "/bulk-triage/batch");
      expect((batchCall?.body as { action: string })?.action).toBe("done");
    });
  });

  it("names the failed account and reason on a partial failure", async () => {
    await seedTodayThreads();
    stubFetchWithBulkTriage({
      batch: () =>
        jsonResponse({
          batchId: "batch-1",
          affectedCount: 2,
          accounts: [
            {
              mailAccountId: "acct-1",
              status: "rejected",
              affectedCount: 0,
              reason: "needs_reauth",
            },
          ],
        }),
    });

    renderMail();
    await screen.findByText("Thread A");
    fireEvent.click(await screen.findByRole("button", { name: "Done with Today" }));

    expect(await screen.findByText(/acct-1@example\.test needs reauth/)).toBeDefined();
  });

  it("shows the group's true total from the count endpoint, not the loaded count", async () => {
    await seedTodayThreads();
    stubFetchWithBulkTriage({ count: () => jsonResponse({ count: 4200 }) });

    renderMail();
    await screen.findByText("Thread A");
    fireEvent.mouseEnter(document.querySelector(".group-header-cluster") as HTMLElement);

    expect(await screen.findByText("4200")).toBeDefined();
  });
});
