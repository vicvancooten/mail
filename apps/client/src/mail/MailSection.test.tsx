import type { SyncResponse } from "@mail/shared";
import { labelId } from "@mail/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { publishNotificationTarget } from "../pwa/notification-router.js";
import { EMPTY_COMPOSE_CONTENT, saveComposition } from "../store/compositions.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
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
  // View mode / Stream mode / last account are Device Preferences stored in
  // `localStorage` (device-preferences.ts) — never leak one test's choice
  // into the next.
  localStorage.clear();
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

function renderMail() {
  return render(
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
    const detail = await screen.findByText("Last state", { selector: ".thread-detail-card h1" });
    expect(detail.closest(".thread-detail")?.textContent).toContain("Snippet t1");
  });

  it("switches between Split and List view, and remembers the choice across a remount", async () => {
    await seedCachedMail();
    stubFetch(never);

    const { unmount } = renderMail();
    expect(await screen.findByText("Last state")).toBeDefined();

    // Split view: list and reading pane both present at once.
    expect(document.querySelector(".split-view")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(document.querySelector(".split-view")).toBeNull();

    // List view: opening a Thread swaps the list for a full-screen detail,
    // with a way back rather than sitting beside it.
    fireEvent.click(screen.getByText("Last state"));
    expect(await screen.findByText("Back to list")).toBeDefined();
    fireEvent.click(screen.getByText("Back to list"));
    expect(await screen.findByText("Last state")).toBeDefined();

    unmount();
    cleanup();
    renderMail();

    await screen.findByText("Last state");
    expect(document.querySelector(".split-view")).toBeNull();
  });

  it("Stream mode replaces whichever of Split/List is showing, independent of that choice", async () => {
    await seedCachedMail();
    stubFetch(never);

    renderMail();
    await screen.findByText("Last state");

    fireEvent.click(screen.getByRole("button", { name: /Stream mode/ }));

    // No list at all in Stream mode — straight to the one-thread card.
    expect(document.querySelector(".split-view")).toBeNull();
    expect(document.querySelector(".stream-view")).not.toBeNull();
    expect(await screen.findByText("Snippet t1")).toBeDefined();
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
      await screen.findByText("Account two thread", { selector: ".thread-detail-card h1" }),
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

  it("selecting an unread Thread marks it read; u toggles it back to unread (#42)", async () => {
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
    expect(await screen.findByRole("button", { name: "Mark unread" })).toBeDefined();

    fireEvent.keyDown(window, { key: "u" });
    expect(await screen.findByRole("button", { name: "Mark read" })).toBeDefined();
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Newer thread/ }).className).toContain("unread");
    });
  });

  it("the auto-advance direction toggle in the top bar flips trash's neighbor choice", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");
    fireEvent.click(screen.getByRole("button", { name: /Next: Older/ }));
    expect(await screen.findByRole("button", { name: /Next: Newer/ })).toBeDefined();

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
    expect(screen.getByText("Pinned")).toBeDefined(); // the synthetic group header
  });

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

    const composeButton = await screen.findByTitle("Compose (c)");
    fireEvent.click(composeButton);

    const subject = await screen.findByPlaceholderText("Subject");
    fireEvent.change(subject, { target: { value: "Do not lose this" } });

    fireEvent.click(composeButton);

    const stillOpen = await screen.findByPlaceholderText("Subject");
    expect(stillOpen).toBe(subject); // the same input — the composer was never unmounted
    expect((stillOpen as HTMLInputElement).value).toBe("Do not lose this");
  });
});
