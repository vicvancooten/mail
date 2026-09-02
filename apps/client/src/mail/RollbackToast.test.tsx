import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { enqueueMutation, resolveMutationOutcomes } from "../store/mutation-queue.js";
import { RollbackToast } from "./RollbackToast.js";

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
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("RollbackToast", () => {
  it("renders nothing until a mutation is rejected", () => {
    render(<RollbackToast />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the failed action once a rejection arrives, then auto-dismisses", async () => {
    render(<RollbackToast autoDismissMs={30} />);

    await act(async () => {
      await rejectOne({ type: "archive", threadId: "t1" }, "thread_not_found");
    });

    expect(screen.getByRole("status").textContent).toBe("Couldn't archive — restored to the list.");

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("describes a trash rejection distinctly from archive", async () => {
    render(<RollbackToast />);

    await act(async () => {
      await rejectOne({ type: "trash", threadId: "t1" }, "thread_not_found");
    });

    expect(screen.getByRole("status").textContent).toBe(
      "Couldn't move to trash — restored to the list.",
    );
  });

  it("names the label on a rejected applyLabel", async () => {
    render(<RollbackToast />);

    await act(async () => {
      await rejectOne({ type: "applyLabel", threadId: "t1", name: "Receipts" }, "server_error");
    });

    expect(screen.getByRole("status").textContent).toBe('Couldn\'t apply "Receipts" — undone.');
  });

  it("replaces the message on a second rejection before the first dismisses", async () => {
    render(<RollbackToast autoDismissMs={10_000} />);

    await act(async () => {
      await rejectOne({ type: "archive", threadId: "t1" }, "thread_not_found");
    });
    await act(async () => {
      await rejectOne({ type: "trash", threadId: "t2" }, "thread_not_found");
    });

    expect(screen.getByRole("status").textContent).toBe(
      "Couldn't move to trash — restored to the list.",
    );
  });
});
