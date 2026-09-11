import type { SyncResponse } from "@mail/shared";
import { EMPTY_NOTE_DOCUMENT, gmailLabelId, labelId } from "@mail/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { Toaster } from "../components/ui/sonner.js";
import { publishNotificationTarget } from "../pwa/notification-router.js";
import { EMPTY_COMPOSE_CONTENT, saveComposition } from "../store/compositions.js";
import {
  enqueueUserMutation,
  readNote,
  readTask,
  readTasks,
  useConnectedAccounts,
} from "../store/index.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { listQueuedMutations, resolveMutationOutcomes } from "../store/mutation-queue.js";
import {
  applyConnectedAccountDelta,
  applyGmailLabelDelta,
  applyLabelDelta,
  applyMailAccountDelta,
  applyTaskListDelta,
  applyThreadDelta,
} from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { resetSyncStatus } from "../sync/sync-loop.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import {
  delta,
  makeConnectedAccount,
  makeGmailLabel,
  makeLabel,
  makeMailAccount,
  makeTaskList,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { stubMatchMedia } from "../test-support/match-media.js";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { PaletteHostTestProvider } from "../test-support/palette-host-harness.js";
import { AccountScope } from "./AccountScope.js";
import { resetActiveMailHost } from "./actions/active-mail-host.js";
import { resetSurfaceHandles } from "./actions/surface-handles.js";

import { writeViewMode } from "./device-preferences.js";
import { MailSection } from "./MailSection.js";
import { invalidateThreadMessages } from "./reading/useThreadMessages.js";
import { resetScrollOffsetsForTest } from "./scroll-restore.js";
import { taperHeaderHeight, taperRowHeight } from "./taper.js";
import { resetUndoToastsForTest } from "./undo-toast.js";
import { useAccountScope } from "./useAccountScope.js";

/**
 * A call-through spy, not a replacement — `invalidateThreadMessages` keeps
 * its real behaviour (the #144-review test below needs the real per-tab
 * cache, not a stub of it), just recorded so that test can assert *when*
 * it's called without reaching into `useThreadMessages.ts`'s own module
 * state.
 */
vi.mock("./reading/useThreadMessages.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./reading/useThreadMessages.js")>();
  return { ...actual, invalidateThreadMessages: vi.fn(actual.invalidateThreadMessages) };
});

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

const USER = "user-1";
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
  // The Undo toast's coalescing buckets are module state too (`undo-toast.ts`'s
  // own doc comment on this seam) — a Done/Trash from one test must never
  // fold into the next test's own toast count.
  resetUndoToastsForTest();
  // `scroll-restore.ts`'s saved-offset map is module state too (#142, its
  // own doc comment) — it has to survive `MailSection` unmounting for a
  // Stream/Settings round trip, which also means it survives past this
  // test unless cleared: many fixtures here share the same Account +
  // folder + label, so a saved offset would otherwise leak into the next
  // test's first mount of that same list.
  resetScrollOffsetsForTest();
  // The `invalidateThreadMessages` call-through spy (above) is a module-level
  // `vi.fn`, so its own call history is as much a leak risk as the module
  // state it wraps.
  vi.mocked(invalidateThreadMessages).mockClear();
  // `active-mail-host.ts`/`surface-handles.ts` (#147) are module state too,
  // published by whichever Mail-family surface is mounted and cleared on its
  // unmount — but that clear only runs if the effect's cleanup actually
  // fires before the next test's own mount reads it, which an interrupted
  // render can't guarantee. Their own "Test-only" reset exports are exactly
  // for this: drop a stale host/handle rather than let it survive into the
  // next test's first render.
  resetActiveMailHost();
  resetSurfaceHandles();
  const name = `mail-section-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  // A Label id is derived from the signed-in User (#186). `AuthProvider`
  // mirrors it in the real app; here `stubFetch` never answers
  // `/auth/session`, so the tests state it directly.
  setSessionUserId(USER);
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
  setSessionUserId(null);
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

/**
 * The Connected Account each `makeMailAccount(id)` above joins to (#207,
 * `mail-fixtures.ts#makeConnectedAccount`'s own doc comment on the shared
 * `${id}-connected` default id) — every Account Scope test below needs a
 * matching row here too, since `AccountScope.tsx` picks its rows from the
 * Connected Accounts collection now, not `MailAccount`.
 */
async function seedConnectedAccountsFor(...mailAccountIds: string[]): Promise<void> {
  await applyConnectedAccountDelta(
    delta({ created: mailAccountIds.map((id) => makeConnectedAccount(`${id}-connected`)) }),
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

/** Three Threads, newest first: "Row 1", "Row 2", "Row 3" — #152's hover re-arm, where the order rows slide up in matters. */
async function seedThreeThreads(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({
      created: [
        makeThread("t-3", "acct-1", {
          subject: "Row 3",
          unreadCount: 0,
          lastMessageAt: minutesAfterEpoch(1),
        }),
        makeThread("t-2", "acct-1", {
          subject: "Row 2",
          unreadCount: 0,
          lastMessageAt: minutesAfterEpoch(2),
        }),
        makeThread("t-1", "acct-1", {
          subject: "Row 1",
          unreadCount: 0,
          lastMessageAt: minutesAfterEpoch(3),
        }),
      ],
    }),
    { replace: false },
  );
}

/**
 * Account Scope's own control lives in the Hub now (#96,
 * `router/RootLayout.tsx`), a separate component from `MailSection` — this
 * stands in for it here, wired to the same reactive store
 * (`useAccountScope.ts`) `MailSection` itself reads, so these tests still
 * exercise the real production components (`AccountScope.tsx`,
 * `useAccountScope`) end to end rather than asserting on `MailSection`'s
 * internals directly. Renders nothing with 0-1 Connected Accounts
 * (`AccountScope.tsx`'s own guard) — a single-account test that seeds no
 * Connected Account row at all reads as zero here, same result as one.
 * `activeFacet="mail"` throughout — every test in this file is Mail's own
 * suite, so this harness never needs to exercise the muted-row path a
 * different App's Facet would trigger.
 */
function AccountScopeHarness() {
  const connectedAccounts = useConnectedAccounts() ?? [];
  const { scope, setScope } = useAccountScope(connectedAccounts);
  return (
    <AccountScope
      accounts={connectedAccounts}
      scope={scope}
      activeFacet="mail"
      onChange={setScope}
    />
  );
}

/**
 * The sync loop's own home is the Client shell now (#285,
 * `router/RootLayout.tsx`), a separate component from `MailSection` —
 * `AccountScopeHarness`'s own reasoning above applies verbatim: stands in
 * for the shell here so this file's own sync-round assertions ("converges
 * on a cold, empty cache", "Undo ... re-syncs") still exercise the real
 * `useLocalCacheSync`/`startSyncLoop` rather than asserting on `MailSection`
 * with no sync loop running at all underneath it.
 */
function LocalCacheSyncHarness() {
  useLocalCacheSync();
  return null;
}

function renderMail(props: Partial<Parameters<typeof MailSection>[0]> = {}) {
  return render(
    <AuthProvider>
      <LocalCacheSyncHarness />
      <AccountScopeHarness />
      <PaletteHostTestProvider>
        <MailSection {...props} />
      </PaletteHostTestProvider>
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
        connectedAccounts: {},
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
        connectedAccounts: {},
      },
    ];
    stubFetch(() =>
      Promise.resolve(
        jsonResponse(responses.shift() ?? { user: {}, mailAccounts: {}, connectedAccounts: {} }),
      ),
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

  it('"Add to Notes" (#195) creates the Note at once and hands its id to onNoteCreated', async () => {
    await seedCachedMail();
    stubFetch(never);
    const onNoteCreated = vi.fn();

    renderMail({ onNoteCreated });
    await screen.findByText("Last state");
    fireEvent.keyDown(window, { key: "j" });
    await screen.findByRole("button", { name: "Add to Notes" });

    fireEvent.click(screen.getByRole("button", { name: "Add to Notes" }));

    await waitFor(() => expect(onNoteCreated).toHaveBeenCalledOnce());
    const noteId = onNoteCreated.mock.calls[0]?.[0] as string;
    const note = await readNote(noteId);
    expect(note?.document).toMatchObject([
      { type: "paragraph", content: [{ type: "text", text: "Last state", styles: {} }] },
      { type: "threadLink", props: { threadId: "t1", subject: "Last state" } },
    ]);

    // The same Undo path every other structural action gets (ADR-0019):
    // Undo enqueues `deleteNote`'s own inverse intent, removing the row.
    expect(await screen.findByText("Added to Notes")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect(await readNote(noteId)).toBeUndefined());
  });

  describe('"Add to Tasks" (#258)', () => {
    async function seedDefaultTaskList(): Promise<void> {
      await applyTaskListDelta(
        delta({ created: [makeTaskList("list-1", USER, { name: "Tasks", isDefault: true })] }),
        { replace: false },
      );
    }

    it("opens a sheet prefilled from the Thread, and Add creates the Task with its Thread Link field, one Undo toast", async () => {
      await seedCachedMail();
      await seedDefaultTaskList();
      stubFetch(never);

      renderMail();
      await screen.findByText("Last state");
      fireEvent.keyDown(window, { key: "j" });
      await screen.findByRole("button", { name: "Add to Tasks" });
      fireEvent.click(screen.getByRole("button", { name: "Add to Tasks" }));

      const titleField = await screen.findByLabelText("Task title");
      expect((titleField as HTMLInputElement).value).toBe("Last state");

      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      await waitFor(() => expect(screen.queryByLabelText("Task title")).toBeNull());
      const tasks = await readTasks("list-1");
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task?.title).toBe("Last state");
      expect(task?.threadLink).toEqual({
        threadId: "t1",
        subject: "Last state",
        participants: "Ada",
        date: expect.any(String),
      });
      // "The mail itself is never copied into the Task" — no body write at all.
      expect(task?.document).toEqual(EMPTY_NOTE_DOCUMENT);

      expect(await screen.findByText("Added to Tasks")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(async () => expect(await readTasks("list-1")).toHaveLength(0));
      // Lets the toast's own exit animation finish before the next test's
      // sheet raises its own — sonner's toast store outlives `cleanup()`
      // (`afterEach`'s own doc comment above).
      await waitFor(() => expect(screen.queryByText("Added to Tasks")).toBeNull());
    });

    it("Add and mark Done creates the Task and archives the Thread as one action, one Undo reversing both", async () => {
      await seedCachedMail();
      await seedDefaultTaskList();
      stubFetch(never);

      renderMail();
      await screen.findByText("Last state");
      fireEvent.keyDown(window, { key: "j" });
      await screen.findByRole("button", { name: "Add to Tasks" });
      fireEvent.click(screen.getByRole("button", { name: "Add to Tasks" }));
      await screen.findByLabelText("Task title");

      fireEvent.click(screen.getByRole("button", { name: "Add and mark Done" }));

      const tasks = await waitFor(async () => {
        const rows = await readTasks("list-1");
        expect(rows).toHaveLength(1);
        return rows;
      });
      const taskId = tasks[0]?.id as string;

      // One toast, one Undo — not a second, separate "Done" toast.
      expect(await screen.findByText("Added to Tasks and marked Done")).toBeDefined();
      await waitFor(async () => expect(await readTasks("list-1")).toHaveLength(1));

      fireEvent.click(screen.getByRole("button", { name: "Undo" }));

      // Both halves of the compound Undo land together: the Task is gone
      // and the Thread is back in the Inbox row (its own list entry, back
      // alongside the reading pane's header), one Undo click for both.
      await waitFor(async () => expect(await readTasks("list-1")).toHaveLength(0));
      await waitFor(async () => expect(await screen.findAllByText("Last state")).toHaveLength(2));
      expect(await readTask(taskId)).toBeUndefined();
    });
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
    await seedConnectedAccountsFor("acct-1", "acct-2");
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
    await seedConnectedAccountsFor("acct-1", "acct-2");
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
    await seedConnectedAccountsFor("acct-1", "acct-2");
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
    await seedConnectedAccountsFor("acct-1", "acct-2");
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

  it("Arrow keys and j/k move DOM focus together with the selection, not just aria-selected (#275)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Newer thread/ })),
    );

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Older thread/ })),
    );

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Newer thread/ })),
    );

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Newer thread/ })),
    );
  });

  it("after Done on the focused row, focus follows Auto-advance to the row it selects — the listbox itself once nothing remains (#275)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Newer thread");

    fireEvent.keyDown(window, { key: "j" }); // selects and focuses "Newer thread"
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Newer thread/ })),
    );

    fireEvent.keyDown(window, { key: "e" }); // Done — Auto-advance lands on "Older thread"
    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Older thread/ })),
    );

    fireEvent.keyDown(window, { key: "e" }); // Done on the last Thread — nothing left to land on
    await waitFor(() => expect(screen.queryByText("Older thread")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("listbox")));
  });

  it("two Dones dispatched before the first re-render select the Thread after both, never the removed one (#275)", async () => {
    await seedThreeThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Row 1");
    fireEvent.click(screen.getByText("Row 1"));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Row 1/ }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );

    const doneRow1 = screen.getByRole("button", { name: 'Mark "Row 1" Done' });
    const doneRow2 = screen.getByRole("button", { name: 'Mark "Row 2" Done' });
    // Both clicks land inside one `act`, with no re-render in between — the
    // exact race #275 fixes: a second Triage call reading `selectedThreadId`
    // as a stale render-time prop would see "Row 1" still selected for
    // *both* calls and strand the final selection on "Row 2" instead of
    // advancing past it too.
    act(() => {
      fireEvent.click(doneRow1);
      fireEvent.click(doneRow2);
    });

    await waitFor(() => expect(screen.queryByText("Row 1")).toBeNull());
    await waitFor(() => expect(screen.queryByText("Row 2")).toBeNull());
    expect(
      (await screen.findByRole("option", { name: /Row 3/ })).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("a late URL echo naming a Thread older than the current selection does not change the selection (#275)", async () => {
    await seedThreeThreads();
    stubFetch(never);

    const { rerender } = renderMail({ initialThreadId: "t-1" }); // "Row 1", the newest
    await screen.findByRole("option", { name: /Row 1/ });

    fireEvent.click(screen.getByRole("option", { name: /Row 2/ }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Row 2/ }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );

    // A stale router snapshot re-delivers an older `initialThreadId` — "Row
    // 3" sits further down the (newest-first) list than the already-selected
    // "Row 2" — simulating a late echo of the URL as it stood before the
    // click above landed.
    rerender(
      <AuthProvider>
        <LocalCacheSyncHarness />
        <AccountScopeHarness />
        <PaletteHostTestProvider>
          <MailSection initialThreadId="t-3" />
        </PaletteHostTestProvider>
        <Toaster />
      </AuthProvider>,
    );

    expect(screen.getByRole("option", { name: /Row 2/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("option", { name: /Row 3/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
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

  it("arms the row that slides under a stationary pointer once Done removes the row above it, for several rows in a row (#152)", async () => {
    await seedThreeThreads();
    stubFetch(never);

    renderMail();
    await screen.findByText("Row 1");

    // `.thread-list`'s own bounding rect: jsdom has no layout engine (all
    // zero by default) — stub just this one container's so a `clientY` can
    // be translated into a position within the scrolled content
    // (`VirtualizedThreadList`'s own pointer-to-item math). Scoped to this
    // one element, not `HTMLDivElement.prototype` — every row is a `<div>`
    // too, and `measureElement` (#75) reads its own `getBoundingClientRect`
    // for its real height; patching the prototype would measure every row
    // at the container's 600px instead of its own taper height.
    const list = document.querySelector(".thread-list") as HTMLElement;
    const rect = vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      right: 400,
      bottom: 600,
      width: 400,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    } as DOMRect);

    const rowOf = (subject: string) =>
      screen.getByText(subject).closest('[role="option"]') as HTMLElement;
    const doneButtonFor = (subject: string) =>
      screen.getByRole("button", { name: `Mark "${subject}" Done` });

    // All three land in one group ("Older", decades-old fixtures) — the
    // pointer rests at the middle of the topmost row's own slot.
    const y = taperHeaderHeight(4, "comfortable") + taperRowHeight(4, "comfortable") / 2;
    fireEvent.mouseMove(list, { clientX: 10, clientY: y });
    fireEvent.mouseEnter(rowOf("Row 1"));
    expect(rowOf("Row 1").getAttribute("data-armed")).toBe("true");

    // Done on Row 1 — no pointer movement follows. Row 2 slides up into
    // Row 1's screen slot and must arm on its own; `mail.css` only enables
    // `.done-btn`'s `pointer-events` once `data-armed="true"`, so this is
    // what makes a same-spot second click land on Done rather than falling
    // through to the row's own `onClick` (open the mail).
    fireEvent.click(doneButtonFor("Row 1"));
    await waitFor(() => expect(screen.queryByText("Row 1")).toBeNull());
    await waitFor(() => expect(rowOf("Row 2").getAttribute("data-armed")).toBe("true"));

    // A second Done at the same spot, still with no pointer movement
    // between — Row 3 arms too.
    fireEvent.click(doneButtonFor("Row 2"));
    await waitFor(() => expect(screen.queryByText("Row 2")).toBeNull());
    await waitFor(() => expect(rowOf("Row 3").getAttribute("data-armed")).toBe("true"));

    // Moving the pointer away still disarms it, same as today.
    fireEvent.mouseMove(list, { clientX: 10, clientY: y + 500 });
    expect(rowOf("Row 3").getAttribute("data-armed")).toBe("false");

    rect.mockRestore();
  });

  it("selecting an unread Thread marks it read; the Reader's More menu toggles it back (#42, #143)", async () => {
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

    // `u` no longer toggles read/unread (#79 rebinds it to "back to list") —
    // the mouse affordance now lives in the Reader's More menu (#143's own
    // `reader-more` tier), plus the Command Palette (`command-palette.test.tsx`).
    // The trigger only opens for a real pointer-event sequence (`userEvent`),
    // not a bare synthetic click — same as every other Radix Dropdown/Menu
    // trigger in this suite.
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /More actions for "Newer/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as unread" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Newer thread/ }).className).toContain("unread");
    });

    await user.click(await screen.findByRole("button", { name: /More actions for "Newer/ }));
    expect(await screen.findByRole("menuitem", { name: "Mark as read" })).toBeDefined();
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

  it("right-clicking a row opens the Action registry's menu, and Trash — which has no row *hover* control — works from it (#94)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    const row = await screen.findByRole("option", { name: /Newer thread/ });

    fireEvent.contextMenu(row);

    // The menu names the Thread it is about, and lists Trash with its own
    // keycap — #66 gave it no hover-cluster control, which on touch is
    // otherwise reached only by swiping left (#149) or through this menu.
    const trash = await screen.findByRole("menuitem", { name: /Move to Trash/ });
    expect(trash.textContent).toContain("#");
    fireEvent.click(trash);

    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
  });

  it("swiping a row right commits Done, and left commits Trash, both past the threshold (#149)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    const row = await screen.findByRole("option", { name: /Newer thread/ });

    // Right, past the commit threshold: Done — same Optimistic Action and
    // Undo toast as the row's own Done button.
    fireEvent.pointerDown(row, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(row, { pointerId: 1, pointerType: "touch", clientX: 120 });
    fireEvent.pointerUp(row, { pointerId: 1, pointerType: "touch", clientX: 120 });

    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    // Same coalescing Undo toast every other Triage path raises (#95,
    // ADR-0019) — "Done" collides with the row's own (hidden) swipe-reveal
    // label, so the Undo button is the toast's unambiguous signature.
    expect(await screen.findByRole("button", { name: "Undo" })).toBeDefined();

    // Left, past the commit threshold, on the remaining row: Trash.
    const older = await screen.findByRole("option", { name: /Older thread/ });
    fireEvent.pointerDown(older, { pointerId: 2, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(older, { pointerId: 2, pointerType: "touch", clientX: -120 });
    fireEvent.pointerUp(older, { pointerId: 2, pointerType: "touch", clientX: -120 });

    await waitFor(() => expect(screen.queryByText("Older thread")).toBeNull());
    expect(await screen.findByText("Moved to trash")).toBeDefined();
  });

  it("releasing a row swipe short of the threshold cancels — the row springs back with no action taken (#149)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    const row = await screen.findByRole("option", { name: /Newer thread/ });

    fireEvent.pointerDown(row, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(row, { pointerId: 1, pointerType: "touch", clientX: 40 });
    fireEvent.pointerUp(row, { pointerId: 1, pointerType: "touch", clientX: 40 });

    // Still here, still selectable — no Optimistic Action was queued.
    await waitFor(() => expect(listQueuedMutations("acct-1")).resolves.toHaveLength(0));
    expect(screen.getByText("Newer thread")).toBeDefined();
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

describe("Reader action hierarchy (#143)", () => {
  it("renders Reply/Done/Snooze/Trash as primaries, Pin/Star/Label inline and quieter, and everything else in the More menu", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.click(await screen.findByText("Newer thread"));
    await screen.findByText("Newer thread", { selector: ".reading-subject" });

    // The primary tier: visible on every surface (Split, List, phone, Stream).
    expect(screen.getByRole("button", { name: "Reply" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Done — archive this thread" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Snooze" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeDefined();

    // The secondary tier: inline, but visually quieter — desktop only.
    expect(screen.getByRole("button", { name: "Pin" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Star" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Apply or remove a label" })).toBeDefined();

    // Read/unread (the `reader-more` tier — Forward joins it too, but only
    // once a Message has loaded to forward, which this test doesn't wait
    // for) is reachable *only* from the More menu, and the secondary tier
    // doesn't also duplicate into it on desktop.
    expect(screen.queryByRole("button", { name: /Mark as (read|unread)/ })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /More actions for "Newer/ }));
    expect(await screen.findByRole("menuitem", { name: "Mark as unread" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
  });

  it("on a touch-capable phone the Reader shows only the four primaries plus More, folding Pin/Star/Label into it and dropping prev/next", async () => {
    // `useTouchCapablePhone` (#143) is phone width *and* no hover-capable
    // pointer — matching only the phone-width query reports every other
    // query (including the hover one) as not matching, same stub
    // `settings-phone-integration.test.tsx` uses for the same 768px breakpoint.
    stubMatchMedia((query) => query === "(max-width: 767px)");
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.click(await screen.findByText("Newer thread"));
    await screen.findByText("Newer thread", { selector: ".reading-subject" });

    expect(screen.getByRole("button", { name: "Reply" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Done — archive this thread" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Snooze" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeDefined();

    expect(screen.queryByRole("button", { name: "Previous thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Star" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply or remove a label" })).toBeNull();

    // Pin and Star carry their own keycap (their registry binding), so their
    // menu item's accessible name is the label plus the printed key — a
    // regex, the same way `ActionMenu.test.tsx` matches a keycap-bearing
    // item, rather than an exact string.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /More actions for "Newer/ }));
    expect(await screen.findByRole("menuitem", { name: /Pin/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Star/ })).toBeDefined();
    // Opening the thread marks it read asynchronously; the item's own label
    // flips from "Mark as read" to "Mark as unread" once that settles, same
    // race the desktop version of this menu (line 908, above) polls for.
    expect(await screen.findByRole("menuitem", { name: "Mark as unread" })).toBeDefined();
  });
});

describe("Spam, Approve and Block on any Inbox Thread (#144)", () => {
  it("the row menu offers Spam (with its `!` keycap), Approve and Block, none of which have ever been near the Screener", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    const row = await screen.findByRole("option", { name: /Newer thread/ });
    fireEvent.contextMenu(row);

    const spam = await screen.findByRole("menuitem", { name: /Spam/ });
    expect(spam.textContent).toContain("!");
    expect(await screen.findByRole("menuitem", { name: "Approve" })).toBeDefined();
    expect(await screen.findByRole("menuitem", { name: "Block" })).toBeDefined();
  });

  it("Spam moves the Thread to Junk instantly, records the Verdict against its own sender, and names itself in the Undo toast", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.contextMenu(await screen.findByRole("option", { name: /Newer thread/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Spam/ }));

    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    expect(screen.getByText("Older thread")).toBeDefined();

    const queued = await listQueuedMutations("acct-1");
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "spamSender",
      sender: { scope: "address", value: "ada@example.test" },
      threadId: "t-newer",
    });

    // Named by itself (#108, #144) — never folded into a "Blocked" toast.
    expect(await screen.findByText("Spam")).toBeDefined();
    // #133's "Remote images" decision, #145's own acceptance criteria: Spam
    // records a Blocked Verdict, changing `remoteImagesAllowed` same as
    // Block — the per-tab message cache must be invalidated at enqueue time
    // so the next Reader open for this sender refetches rather than serving
    // a stale response (review follow-up on #144, matching
    // `screener/Screener.tsx#decide`'s own uniform invalidation).
    expect(invalidateThreadMessages).toHaveBeenCalledWith(["t-newer"]);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(screen.getByText("Newer thread")).toBeDefined());
    expect(await listQueuedMutations("acct-1")).toContainEqual(
      expect.objectContaining({
        intent: {
          type: "unblockAndRestore",
          sender: { scope: "address", value: "ada@example.test" },
          threadIds: ["t-newer"],
        },
      }),
    );
    // Undo restores the Thread and so restores the old Verdict too — the
    // cache must be invalidated a second time, same as `approveSender`'s own
    // undo does.
    expect(invalidateThreadMessages).toHaveBeenCalledTimes(2);
  });

  it('Block moves the Thread to Trash instantly and names itself "Blocked" in its own Undo toast', async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.contextMenu(await screen.findByRole("option", { name: /Newer thread/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Block" }));

    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());

    const queued = await listQueuedMutations("acct-1");
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "blockSender",
      sender: { scope: "address", value: "ada@example.test" },
      threadId: "t-newer",
    });
    expect(await screen.findByText("Blocked")).toBeDefined();
    // Same staleness as Spam above — Block records a Blocked Verdict too.
    expect(invalidateThreadMessages).toHaveBeenCalledWith(["t-newer"]);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByText("Newer thread")).toBeDefined());
    expect(invalidateThreadMessages).toHaveBeenCalledTimes(2);
  });

  it("Approve records the Verdict without moving the Thread, and still names itself in the Undo toast", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.contextMenu(await screen.findByRole("option", { name: /Newer thread/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Approve" }));

    // Nothing moves — Approve never held this Thread to release.
    expect(screen.getByText("Newer thread")).toBeDefined();
    expect(await screen.findByText("Approved")).toBeDefined();

    await waitFor(async () => {
      const queued = await listQueuedMutations("acct-1");
      expect(queued.map((mutation) => mutation.intent)).toContainEqual({
        type: "approveSender",
        sender: { scope: "address", value: "ada@example.test" },
        threadId: "t-newer",
      });
    });
    expect(invalidateThreadMessages).toHaveBeenCalledWith(["t-newer"]);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(async () => {
      expect(await listQueuedMutations("acct-1")).toContainEqual(
        expect.objectContaining({
          intent: {
            type: "unblockSender",
            sender: { scope: "address", value: "ada@example.test" },
          },
        }),
      );
    });
    expect(invalidateThreadMessages).toHaveBeenCalledTimes(2);
  });

  it("`!` Spams the open Thread from the keyboard (user story #20), and the Reader's More menu offers all three (#143)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.click(await screen.findByText("Newer thread"));
    await screen.findByText("Newer thread", { selector: ".reading-subject" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /More actions for "Newer/ }));
    expect(await screen.findByRole("menuitem", { name: /Spam/ })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Approve" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Block" })).toBeDefined();
    await user.keyboard("{Escape}");

    fireEvent.keyDown(window, { key: "!" });
    await waitFor(() => expect(screen.queryByText("Newer thread")).toBeNull());
    const queued = await listQueuedMutations("acct-1");
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "spamSender",
      sender: { scope: "address", value: "ada@example.test" },
      threadId: "t-newer",
    });
  });

  it("works on a Mail Account with Gatekeeper off and a Thread the Screener never held — the same as with it on", async () => {
    await applyMailAccountDelta(
      delta({
        created: [makeMailAccount("acct-1", { gatekeeper: { enabled: false, cutoff: null } })],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t-cold", "acct-1", {
            subject: "Never screened",
            participants: [{ name: "Cold Sender", address: "cold@example.test" }],
          }),
        ],
      }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    fireEvent.contextMenu(await screen.findByRole("option", { name: /Never screened/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Spam/ }));

    await waitFor(() => expect(screen.queryByText("Never screened")).toBeNull());
    expect(await listQueuedMutations("acct-1")).toContainEqual(
      expect.objectContaining({
        intent: {
          type: "spamSender",
          sender: { scope: "address", value: "cold@example.test" },
          threadId: "t-cold",
        },
      }),
    );
  });
});

describe("Swipe between Threads inside the Reader (#150)", () => {
  it("swiping the Reader left opens the next (older) Thread, replacing rather than pushing history", async () => {
    // Touch-capable phone (#143): prev/next buttons are gone, so swipe and
    // Auto-advance are the only way to move between Threads without
    // returning to the list first.
    stubMatchMedia((query) => query === "(max-width: 767px)");
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.click(await screen.findByText("Newer thread"));
    await screen.findByText("Newer thread", { selector: ".reading-subject" });

    const pane = document.querySelector(".thread-detail-swipeable") as Element;
    fireEvent.pointerDown(pane, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(pane, { pointerId: 1, pointerType: "touch", clientX: -120 });
    fireEvent.pointerUp(pane, { pointerId: 1, pointerType: "touch", clientX: -120 });

    await screen.findByText("Older thread", { selector: ".reading-subject" });
  });

  it("swiping right from the older (last) Thread opens the previous (newer) one", async () => {
    stubMatchMedia((query) => query === "(max-width: 767px)");
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    fireEvent.click(await screen.findByText("Older thread"));
    await screen.findByText("Older thread", { selector: ".reading-subject" });

    const pane = document.querySelector(".thread-detail-swipeable") as Element;
    fireEvent.pointerDown(pane, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(pane, { pointerId: 1, pointerType: "touch", clientX: 120 });
    fireEvent.pointerUp(pane, { pointerId: 1, pointerType: "touch", clientX: 120 });

    await screen.findByText("Newer thread", { selector: ".reading-subject" });
  });

  it("swiping past the end of the list (no neighbour that way) does nothing — the Thread stays open", async () => {
    stubMatchMedia((query) => query === "(max-width: 767px)");
    await seedTwoThreads();
    stubFetch(never);

    renderMail();
    // "Newer thread" is the newest — there is no *previous* (newer) Thread,
    // so swiping right must be a no-op.
    fireEvent.click(await screen.findByText("Newer thread"));
    await screen.findByText("Newer thread", { selector: ".reading-subject" });

    const pane = document.querySelector(".thread-detail-swipeable") as Element;
    fireEvent.pointerDown(pane, { pointerId: 1, pointerType: "touch", clientX: 0 });
    fireEvent.pointerMove(pane, { pointerId: 1, pointerType: "touch", clientX: 120 });
    fireEvent.pointerUp(pane, { pointerId: 1, pointerType: "touch", clientX: 120 });

    expect(screen.getByText("Newer thread", { selector: ".reading-subject" })).toBeDefined();
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
  it("lists a synced Label in the Sidebar, hidden entirely when there are none (#96: the top bar's own picker is gone, redundant with this)", async () => {
    await seedTwoThreads();
    stubFetch(never);

    const { unmount } = renderMail();
    await screen.findByText("Newer thread");
    // No Labels synced yet — the Sidebar's "Labels" section doesn't show at all.
    expect(screen.queryByText("Labels")).toBeNull();
    unmount();
    cleanup();

    await applyLabelDelta(
      delta({ created: [makeLabel(labelId(USER, "Work"), USER, { name: "Work" })] }),
      { replace: false },
    );
    renderMail();
    await screen.findByText("Newer thread");
    expect(await screen.findByRole("button", { name: "Work" })).toBeDefined();
  });

  it("applies and removes a Label from the keyboard, and selecting it in the Sidebar narrows the corpus (#43, #96)", async () => {
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

    // The Sidebar's own Labels list already shows it (derived from the
    // Thread's own overlay, not a round trip through the `Label`
    // collection) — selecting it narrows the corpus (#96: the top bar's own
    // filter-by-label picker is gone, redundant with this).
    fireEvent.click(await screen.findByRole("button", { name: "Work" }));
    await waitFor(() => expect(screen.queryByText("Older thread")).toBeNull());
    expect(screen.getByText("Newer thread")).toBeDefined();

    // Back to Inbox (selecting a folder clears the Label filter, same as the
    // old "All mail" option did) and reopen the Thread so its detail pane
    // stays reachable once the Label currently filtering it to view is
    // removed.
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
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
      sync: () =>
        Promise.resolve(jsonResponse({ user: {}, mailAccounts: {}, connectedAccounts: {} })),
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

describe("Gmail labels (#126, ADR-0020)", () => {
  it('hides the Sidebar\'s "Gmail labels" section until the collection has rows', async () => {
    await seedTwoThreads();
    stubFetch(never);

    const { unmount } = renderMail();
    await screen.findByText("Newer thread");
    expect(screen.queryByText("Gmail labels")).toBeNull();
    unmount();
    cleanup();

    await applyGmailLabelDelta(
      "acct-1",
      delta({
        created: [
          makeGmailLabel(gmailLabelId("acct-1", "Family/Kids"), "acct-1", {
            name: "Kids",
            path: "Family/Kids",
          }),
        ],
      }),
      { replace: false },
    );
    renderMail();
    await screen.findByText("Newer thread");
    expect(await screen.findByRole("button", { name: "Kids" })).toBeDefined();
  });

  it("selecting a Gmail Label in the Sidebar filters the list to Threads carrying it, archived mail included (#91 story 38)", async () => {
    await applyMailAccountDelta(
      delta({ created: [makeMailAccount("acct-1", { serverKind: "gmail" })] }),
      { replace: false },
    );
    const kidsId = gmailLabelId("acct-1", "Family/Kids");
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t-inbox", "acct-1", {
            subject: "Inbox with the label",
            gmailLabelIds: [kidsId],
            lastMessageAt: minutesAfterEpoch(3),
          }),
          makeThread("t-archived", "acct-1", {
            subject: "Archived with the label",
            inInbox: false,
            folderRole: "archive",
            gmailLabelIds: [kidsId],
            lastMessageAt: minutesAfterEpoch(2),
          }),
          makeThread("t-unlabelled", "acct-1", {
            subject: "No label here",
            lastMessageAt: minutesAfterEpoch(1),
          }),
        ],
      }),
      { replace: false },
    );
    await applyGmailLabelDelta(
      "acct-1",
      delta({
        created: [makeGmailLabel(kidsId, "acct-1", { name: "Kids", path: "Family/Kids" })],
      }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    await screen.findByText("No label here");
    fireEvent.click(await screen.findByRole("button", { name: "Kids" }));

    await waitFor(() => expect(screen.queryByText("No label here")).toBeNull());
    // Both the Inbox and the archived Thread show — unlike a Wicket Label
    // filter (Inbox-scoped), browsing a Gmail Label is archival: "fifteen
    // years of filing is not hidden."
    expect(screen.getByText("Inbox with the label")).toBeDefined();
    expect(screen.getByText("Archived with the label")).toBeDefined();
  });

  it("never offers a Gmail Label from the Label picker (#126, ADR-0020: never a Wicket Label)", async () => {
    await applyMailAccountDelta(
      delta({ created: [makeMailAccount("acct-1", { serverKind: "gmail" })] }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { subject: "Only thread" })] }),
      { replace: false },
    );
    await applyGmailLabelDelta(
      "acct-1",
      delta({
        created: [
          makeGmailLabel(gmailLabelId("acct-1", "Family/Kids"), "acct-1", {
            name: "Kids",
            path: "Family/Kids",
          }),
        ],
      }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    fireEvent.click(await screen.findByText("Only thread"));
    fireEvent.keyDown(window, { key: "L" });
    await screen.findByLabelText("New label name");

    expect(screen.queryByRole("menuitemcheckbox", { name: /Kids/ })).toBeNull();
  });

  /**
   * Post-merge #126 fix: `gmailLabelFilter` used to be a state field of its
   * own, never reset by the "primary account changed" effect that already
   * clears `labelFilter` — a Gmail Label filter selected for one account
   * could keep narrowing the view (to a label id that means nothing for the
   * newly primary account) after Account Scope switched away from it.
   */
  it("clears an active Gmail Label filter when Account Scope's primary account switches (#126 post-merge fix)", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("acct-1", { serverKind: "gmail", createdAt: "2026-01-01T00:00:00.000Z" }),
          makeMailAccount("acct-2", { createdAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );
    await seedConnectedAccountsFor("acct-1", "acct-2");
    const kidsId = gmailLabelId("acct-1", "Family/Kids");
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t1", "acct-1", { subject: "Account one thread", gmailLabelIds: [kidsId] }),
        ],
      }),
      { replace: false },
    );
    await applyThreadDelta(
      "acct-2",
      delta({ created: [makeThread("t2", "acct-2", { subject: "Account two thread" })] }),
      { replace: false },
    );
    await applyGmailLabelDelta(
      "acct-1",
      delta({
        created: [makeGmailLabel(kidsId, "acct-1", { name: "Kids", path: "Family/Kids" })],
      }),
      { replace: false },
    );
    stubFetch(never);

    renderMail();
    await screen.findByText("Account one thread");
    fireEvent.click(await screen.findByRole("button", { name: "Kids" }));
    await waitFor(() => expect(screen.queryByText("Account two thread")).toBeNull());
    expect(screen.getByText("Account one thread")).toBeDefined();

    // Narrows Scope's primary account away from acct-1 (Kids' own account) to
    // acct-2 — the same "uncheck the currently-primary account" trigger
    // `MailSection.test.tsx`'s Account Scope suite already uses.
    fireEvent.click(screen.getByRole("button", { name: /Account Scope: All accounts/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "acct-1@example.test" }));

    // The stale Gmail Label filter is gone — back to the ordinary Inbox view,
    // not stuck on a label id that means nothing for acct-2.
    await screen.findByText("Account two thread");
    expect(screen.queryByText("Account one thread")).toBeNull();
    // The Sidebar's own folder highlight agrees: Inbox reads active again,
    // not still suppressed by a filter that's supposed to be gone.
    const inboxButtons = screen.getAllByRole("button", { name: /inbox/i });
    expect(inboxButtons.some((button) => button.getAttribute("data-active") === "true")).toBe(true);
  });
});
