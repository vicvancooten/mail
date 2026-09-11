import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext.js";
import { resetUndoToastsForTest } from "../mail/undo-toast.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyTaskDelta, applyTaskListDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { readDeletedTaskLists, readTask, readTaskList, readTaskLists } from "../store/tasks.js";
import { resetSyncStatus } from "../sync/sync-loop.js";
import { delta, makeTask, makeTaskList } from "../test-support/mail-fixtures.js";
import { jsonResponse } from "../test-support/mock-fetch.js";
import { TasksApp } from "./TasksApp.js";

/**
 * `TasksApp` takes no router dependency of its own (`selectedTaskListId`/
 * `onTaskListCreated` are plain props) — `router/TasksRoute.tsx` is the
 * thin router-aware wrapper, `NoteDialog.test.tsx`'s own split. This file
 * covers the sidebar's create/rename flow and List selection; a List's own
 * Tasks (quick add, grouping, complete/undo) are `TaskListView.test.tsx`'s.
 *
 * `useLocalCacheSync()` (`TasksApp.tsx`'s own top-level call, `NotesGrid.tsx`'s
 * shape) needs a real `AuthProvider` in reach — `mail/MailSection.test.tsx`'s
 * own harness: auth bootstrap answered, `/sync` left hanging so every
 * assertion here reads the seeded Local Cache, never a round trip.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { dismiss: () => {} }),
}));

const AUTH_RESPONSES: Record<string, () => Response> = {
  "/auth/status": () => jsonResponse({ claimed: true }),
  "/auth/session": () =>
    jsonResponse({
      user: { id: "user-1", username: "vic", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" },
    }),
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth = AUTH_RESPONSES[url];
      if (auth) return Promise.resolve(auth());
      if (url === "/sync") return new Promise<Response>(() => {});
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

const USER = "user-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  resetSyncStatus();
  const name = `tasks-app-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  stubFetch();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  setSessionUserId(null);
  resetUndoToastsForTest();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

function renderTasksApp(props: Partial<Parameters<typeof TasksApp>[0]> = {}) {
  return render(
    <AuthProvider>
      <TasksApp
        selectedTaskListId={null}
        onSelectTaskList={vi.fn()}
        onSelectView={vi.fn()}
        onBack={vi.fn()}
        onOpenRecentlyDeleted={vi.fn()}
        {...props}
      />
    </AuthProvider>,
  );
}

describe("TasksApp (#252)", () => {
  it("renders no Task Lists as an empty sidebar and a 'pick a list' main column", async () => {
    renderTasksApp();

    expect(await screen.findByRole("navigation", { name: "Task Lists" })).toBeDefined();
    expect(screen.getByText("Pick a Task List.")).toBeDefined();
  });

  it("creates a Task List from the sidebar and hands its id to onSelectTaskList", async () => {
    const onSelectTaskList = vi.fn();
    renderTasksApp({ onSelectTaskList });
    await screen.findByRole("navigation", { name: "Task Lists" });

    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const input = screen.getByPlaceholderText("List name");
    fireEvent.change(input, { target: { value: "Groceries" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      const lists = await readTaskLists();
      expect(lists.map((list) => list.name)).toEqual(["Groceries"]);
    });
    expect(onSelectTaskList).toHaveBeenCalledTimes(1);
  });

  it("renames a Task List in place from the sidebar", async () => {
    await applyTaskListDelta(
      delta({ created: [makeTaskList("list-1", USER, { name: "Old name", order: 0 })] }),
      { replace: false },
    );

    renderTasksApp();
    await screen.findByText("Old name");

    fireEvent.click(screen.getByRole("button", { name: 'Rename "Old name"' }));
    const input = screen.getByLabelText('Rename "Old name"');
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      expect((await readTaskList("list-1"))?.name).toBe("New name");
    });
  });

  it("clicking a sidebar row calls onSelectTaskList with its id", async () => {
    await applyTaskListDelta(
      delta({ created: [makeTaskList("list-1", USER, { name: "Groceries", order: 0 })] }),
      { replace: false },
    );
    const onSelectTaskList = vi.fn();
    renderTasksApp({ onSelectTaskList });

    fireEvent.click(await screen.findByRole("button", { name: "Groceries" }));

    expect(onSelectTaskList).toHaveBeenCalledWith("list-1");
  });

  it("selecting a List swaps the main column in, and marks the sidebar row current", async () => {
    await applyTaskListDelta(
      delta({ created: [makeTaskList("list-1", USER, { name: "Groceries", order: 0 })] }),
      { replace: false },
    );

    renderTasksApp({ selectedTaskListId: "list-1" });

    expect(await screen.findByRole("heading", { name: "Groceries" })).toBeDefined();
    expect(screen.queryByText("Pick a Task List.")).toBeNull();
    expect(screen.getByRole("button", { name: "Groceries" }).className).toContain("current");
  });

  it("a Task List created from a second Client appears in the sidebar (#252: round-trips to a second Client)", async () => {
    renderTasksApp();
    await screen.findByRole("navigation", { name: "Task Lists" });
    expect(screen.queryByText("Groceries")).toBeNull();

    await applyTaskListDelta(
      delta({ created: [makeTaskList("list-1", USER, { name: "Groceries", order: 0 })] }),
      { replace: false },
    );

    expect(await screen.findByText("Groceries")).toBeDefined();
  });

  it("the 'Recently Deleted' control calls onOpenRecentlyDeleted (#257)", async () => {
    const onOpenRecentlyDeleted = vi.fn();
    renderTasksApp({ onOpenRecentlyDeleted });
    await screen.findByRole("navigation", { name: "Task Lists" });

    fireEvent.click(screen.getByRole("button", { name: "Recently Deleted" }));

    expect(onOpenRecentlyDeleted).toHaveBeenCalledTimes(1);
  });

  describe("Today / Upcoming views (#254)", () => {
    it("renders Today and Upcoming above the Lists", async () => {
      renderTasksApp();

      expect(await screen.findByRole("button", { name: "Today" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Upcoming" })).toBeDefined();
    });

    it("clicking Today calls onSelectView with 'today'", async () => {
      const onSelectView = vi.fn();
      renderTasksApp({ onSelectView });

      fireEvent.click(await screen.findByRole("button", { name: "Today" }));

      expect(onSelectView).toHaveBeenCalledWith("today");
    });

    it("selecting a view swaps the main column in and marks the sidebar entry current", async () => {
      renderTasksApp({ selectedView: "today" });

      expect(await screen.findByRole("heading", { name: "Today" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Today" }).className).toContain("current");
    });

    it("Upcoming offers no Board mode control", async () => {
      renderTasksApp({ selectedView: "upcoming" });

      await screen.findByRole("heading", { name: "Upcoming" });
      expect(screen.queryByRole("button", { name: /board/i })).toBeNull();
    });
  });

  describe("deleting a Task List (#257)", () => {
    it("offers no delete control for the default List", async () => {
      await applyTaskListDelta(
        delta({
          created: [makeTaskList("list-1", USER, { name: "Tasks", order: 0, isDefault: true })],
        }),
        { replace: false },
      );

      renderTasksApp();
      await screen.findByText("Tasks");

      expect(screen.queryByRole("button", { name: 'Delete "Tasks"' })).toBeNull();
    });

    it("soft-deletes the List, cascades onto its own live Tasks, and drops it from the sidebar", async () => {
      // Sonner is mocked whole-module in this file (this file's own top-level
      // `vi.mock`) — the Undo round trip itself (`deleteTaskList`'s captured
      // `taskIds` handed back to `restoreTaskList`) is `store/tasks.test.ts#
      // "deleteTaskList / restoreTaskList"`'s own coverage; this only checks
      // the click reaches that store call.
      await applyTaskListDelta(
        delta({ created: [makeTaskList("list-1", USER, { name: "Groceries", order: 0 })] }),
        { replace: false },
      );
      const taskId = "t1";
      await applyTaskDelta(
        delta({ created: [makeTask(taskId, USER, "list-1", { title: "Buy milk" })] }),
        { replace: false },
      );

      renderTasksApp();
      await screen.findByText("Groceries");

      fireEvent.click(screen.getByRole("button", { name: 'Delete "Groceries"' }));

      await waitFor(async () => {
        expect((await readTaskList("list-1"))?.deletedAt).not.toBeNull();
        expect((await readTask(taskId))?.deletedAt).not.toBeNull();
      });
      expect(screen.queryByText("Groceries")).toBeNull();
    });

    it("lists the deleted List in readDeletedTaskLists once removed from the sidebar", async () => {
      await applyTaskListDelta(
        delta({ created: [makeTaskList("list-1", USER, { name: "Groceries", order: 0 })] }),
        { replace: false },
      );

      renderTasksApp();
      await screen.findByText("Groceries");

      fireEvent.click(screen.getByRole("button", { name: 'Delete "Groceries"' }));

      await waitFor(async () => {
        const deleted = await readDeletedTaskLists();
        expect(deleted.map((entry) => entry.list.id)).toEqual(["list-1"]);
      });
    });
  });

  describe("'See all results' narrowing (#262, `?q=`)", () => {
    it("shows the query as a chip and every matching Task across every List, even with no List selected", async () => {
      await applyTaskListDelta(
        delta({ created: [makeTaskList("list-1", USER, { name: "Groceries", order: 0 })] }),
        { replace: false },
      );
      await applyTaskDelta(
        delta({
          created: [
            makeTask("t1", USER, "list-1", { title: "Buy oat milk" }),
            makeTask("t2", USER, "list-1", { title: "Dentist appointment" }),
          ],
        }),
        { replace: false },
      );

      renderTasksApp({ query: "oat milk" });

      expect(await screen.findByText("Buy oat milk")).toBeDefined();
      expect(screen.queryByText("Dentist appointment")).toBeNull();
      expect(screen.getByText("oat milk")).toBeDefined();
      // No List was selected, but the aggregate view still shows — "See all
      // results" narrows the whole Tasks App, not one List.
      expect(screen.queryByText("Pick a Task List.")).toBeNull();
    });

    it("ranks a completed match below an open one", async () => {
      await applyTaskListDelta(
        delta({ created: [makeTaskList("list-1", USER, { name: "Errands", order: 0 })] }),
        { replace: false },
      );
      await applyTaskDelta(
        delta({
          created: [
            makeTask("done", USER, "list-1", { title: "Done sprocket", completed: true }),
            makeTask("open", USER, "list-1", { title: "Open sprocket" }),
          ],
        }),
        { replace: false },
      );

      renderTasksApp({ query: "sprocket" });
      await screen.findByText("Open sprocket");

      const titles = screen
        .getAllByRole("button", { name: /sprocket/ })
        .map((el) => el.textContent);
      expect(titles).toEqual(["Open sprocket", "Done sprocket"]);
    });

    it("clicking a match calls onOpenTask; the chip's remove control calls onClearQuery", async () => {
      await applyTaskListDelta(
        delta({ created: [makeTaskList("list-1", USER, { name: "Errands", order: 0 })] }),
        { replace: false },
      );
      await applyTaskDelta(
        delta({ created: [makeTask("t1", USER, "list-1", { title: "Buy oat milk" })] }),
        { replace: false },
      );
      const onOpenTask = vi.fn();
      const onClearQuery = vi.fn();

      renderTasksApp({ query: "oat milk", onOpenTask, onClearQuery });
      fireEvent.click(await screen.findByText("Buy oat milk"));
      expect(onOpenTask).toHaveBeenCalledWith("t1");

      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      expect(onClearQuery).toHaveBeenCalledTimes(1);
    });
  });
});
