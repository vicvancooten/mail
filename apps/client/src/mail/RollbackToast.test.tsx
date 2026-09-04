import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Toaster } from "../components/ui/sonner.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import {
  enqueueMutation,
  listQueuedMutations,
  resolveMutationOutcomes,
} from "../store/mutation-queue.js";
import { RollbackToast } from "./RollbackToast.js";

/** `toast()` only ever renders through a mounted `<Toaster />` (#93) — every case renders one alongside the component under test. */
function renderWithToaster(ui: ReactElement) {
  return render(
    <>
      {ui}
      <Toaster />
    </>,
  );
}

/**
 * Drives real rejections through `mutation-queue.ts` (the same seam
 * `store/mutation-queue.test.ts` exercises) rather than reaching for a mock
 * — `RollbackToast` promises to describe what `resolveMutationOutcomes`
 * actually reports, so the test should produce that report the real way.
 * Real timers throughout (a short `autoDismissMs` instead of fake timers):
 * Dexie's IndexedDB round trips don't resolve under `vi.useFakeTimers()`.
 */
async function rejectOne(
  intent: Parameters<typeof enqueueMutation>[0],
  reason: string,
): Promise<void> {
  const id = await enqueueMutation(intent, "acct-1");
  await resolveMutationOutcomes(
    "acct-1",
    [{ id: id as string, intent }],
    [{ id: id as string, status: "rejected", reason }],
  );
}

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `rollback-toast-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  // Sonner's toast store is a module-level singleton, outside React — it
  // outlives `cleanup()`'s unmount, so a toast left over from one test
  // (its dismiss timer not yet due) would otherwise bleed into the next.
  toast.dismiss();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("RollbackToast", () => {
  it("renders nothing until a mutation is rejected", () => {
    renderWithToaster(<RollbackToast />);
    expect(screen.queryByText(/Couldn't/)).toBeNull();
  });

  it("names the failed action once a rejection arrives, then auto-dismisses", async () => {
    renderWithToaster(<RollbackToast autoDismissMs={30} />);

    await act(async () => {
      await rejectOne({ type: "archive", threadId: "t1" }, "thread_not_found");
    });

    await waitFor(() =>
      expect(screen.getByText("Couldn't archive — restored to the list.")).toBeTruthy(),
    );

    await waitFor(() =>
      expect(screen.queryByText("Couldn't archive — restored to the list.")).toBeNull(),
    );
  });

  it("describes a trash rejection distinctly from archive", async () => {
    renderWithToaster(<RollbackToast />);

    await act(async () => {
      await rejectOne({ type: "trash", threadId: "t1" }, "thread_not_found");
    });

    await waitFor(() =>
      expect(screen.getByText("Couldn't move to trash — restored to the list.")).toBeTruthy(),
    );
  });

  it("describes a snooze rejection (#76)", async () => {
    renderWithToaster(<RollbackToast />);

    await act(async () => {
      await rejectOne(
        { type: "snooze", threadId: "t1", until: "2026-06-02T08:00:00.000Z" },
        "invalid_snooze_time",
      );
    });

    await waitFor(() =>
      expect(screen.getByText("Couldn't snooze — restored to the list.")).toBeTruthy(),
    );
  });

  it("names the label on a rejected applyLabel", async () => {
    renderWithToaster(<RollbackToast />);

    await act(async () => {
      await rejectOne({ type: "applyLabel", threadId: "t1", name: "Receipts" }, "server_error");
    });

    await waitFor(() =>
      expect(screen.getByText('Couldn\'t apply "Receipts" — undone.')).toBeTruthy(),
    );
  });

  it("replaces the message on a second rejection before the first dismisses", async () => {
    renderWithToaster(<RollbackToast autoDismissMs={10_000} />);

    await act(async () => {
      await rejectOne({ type: "archive", threadId: "t1" }, "thread_not_found");
    });
    await act(async () => {
      await rejectOne({ type: "trash", threadId: "t2" }, "thread_not_found");
    });

    await waitFor(() =>
      expect(screen.getByText("Couldn't move to trash — restored to the list.")).toBeTruthy(),
    );
    expect(screen.queryByText("Couldn't archive — restored to the list.")).toBeNull();
  });

  it("describes a failed Undo of an archive/trash (restoreToInbox) and of a snooze (unsnooze) (#95)", async () => {
    renderWithToaster(<RollbackToast autoDismissMs={10_000} />);

    await act(async () => {
      await rejectOne({ type: "restoreToInbox", threadId: "t1" }, "thread_not_found");
    });
    await waitFor(() => expect(screen.getByText("Couldn't restore to the Inbox.")).toBeTruthy());

    await act(async () => {
      await rejectOne({ type: "unsnooze", threadId: "t2" }, "thread_not_found");
    });
    await waitFor(() => expect(screen.getByText("Couldn't unsnooze.")).toBeTruthy());
  });

  it("describes a failed Undo of a Screener Deny/Block (unblockAndRestore) (#95)", async () => {
    renderWithToaster(<RollbackToast autoDismissMs={10_000} />);

    await act(async () => {
      await rejectOne(
        {
          type: "unblockAndRestore",
          sender: { scope: "address", value: "stranger@example.test" },
          threadIds: ["t1"],
        },
        "server_error",
      );
    });

    await waitFor(() =>
      expect(
        screen.getByText("Couldn't undo — they're still blocked and the mail is still in Trash."),
      ).toBeTruthy(),
    );
  });

  it("re-enqueues the exact same intent on Retry (#95, ADR-0011's own promise)", async () => {
    renderWithToaster(<RollbackToast autoDismissMs={10_000} />);

    await act(async () => {
      await rejectOne({ type: "archive", threadId: "t1" }, "thread_not_found");
    });
    await waitFor(() =>
      expect(screen.getByText("Couldn't archive — restored to the list.")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Retry"));

    await waitFor(async () => {
      const queued = await listQueuedMutations("acct-1");
      expect(queued.map((mutation) => mutation.intent)).toEqual([
        { type: "archive", threadId: "t1" },
      ]);
    });
  });
});
