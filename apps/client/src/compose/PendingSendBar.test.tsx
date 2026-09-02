import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { listQueuedMutations } from "../store/mutation-queue.js";
import { applyCompositionDelta } from "../store/server-writes.js";
import { delta, makeComposition } from "../test-support/mail-fixtures.js";
import { PendingSendBar } from "./PendingSendBar.js";

/**
 * The ticket's first acceptance line, from the *other* device's side: a
 * Pending Send this tab never started shows a live countdown and can be
 * cancelled, which is the whole reason ADR-0007 puts the pending send in the
 * backend. Everything the bar renders comes from the synced `Composition`
 * collection, so seeding it is exactly seeding a sync round.
 */

const ACCOUNT = "acct-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `pending-send-bar-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/** Seeds the row a sync round would have written, as another device's send. */
async function seedPendingSend(secondsFromNow: number, overrides = {}) {
  await applyCompositionDelta(
    ACCOUNT,
    delta({
      created: [
        makeComposition("comp-1", ACCOUNT, {
          subject: "Dinner plans",
          status: "pending",
          submitAfter: new Date(Date.now() + secondsFromNow * 1000).toISOString(),
          ...overrides,
        }),
      ],
    }),
    { replace: false },
  );
}

describe("PendingSendBar", () => {
  it("shows a countdown for a Pending Send this device never started", async () => {
    await seedPendingSend(9);
    render(<PendingSendBar mailAccountId={ACCOUNT} onReopen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/Sending “Dinner plans” in \d+s/);
    });
    expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
  });

  it("cancels from here, queues the intent, and reopens the composer on this device", async () => {
    await seedPendingSend(9);
    const onReopen = vi.fn();
    render(<PendingSendBar mailAccountId={ACCOUNT} onReopen={onReopen} />);

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: /Undo/ })));

    await waitFor(async () => {
      expect((await listQueuedMutations(ACCOUNT)).map((m) => m.intent)).toEqual([
        { type: "cancelSend", compositionId: "comp-1" },
      ]);
    });
    // ADR-0007: "cancelling restores a Draft and reopens the composer on
    // whichever device cancelled".
    expect(onReopen).toHaveBeenCalledWith("comp-1");
  });

  it("offers no Undo once the send has been claimed — the claim is the point of no return", async () => {
    await seedPendingSend(0, { status: "submitting", submitAfter: null });
    render(<PendingSendBar mailAccountId={ACCOUNT} onReopen={() => {}} />);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Sending “Dinner plans”…");
    });
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("says a queued-but-unaccepted send will go when reconnected, rather than counting from nothing", async () => {
    await applyCompositionDelta(
      ACCOUNT,
      delta({ created: [makeComposition("comp-1", ACCOUNT, { subject: "Offline note" })] }),
      { replace: false },
    );
    const row = await localCache().compositions.get("comp-1");
    if (!row) throw new Error("seed failed");
    await localCache().compositions.put({ ...row, sendState: "queued" });

    render(<PendingSendBar mailAccountId={ACCOUNT} onReopen={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "“Offline note” will send when reconnected",
      );
    });
  });

  it("reports a cancel that lost the race", async () => {
    await seedPendingSend(0, { status: "submitting", submitAfter: null });
    const row = await localCache().compositions.get("comp-1");
    if (!row) throw new Error("seed failed");
    await localCache().compositions.put({ ...row, sendState: "too_late" });

    render(<PendingSendBar mailAccountId={ACCOUNT} onReopen={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "Too late to undo — “Dinner plans” is already on its way",
      );
    });
  });

  it("renders nothing at all when no send is in flight", async () => {
    await applyCompositionDelta(ACCOUNT, delta({ created: [makeComposition("comp-1", ACCOUNT)] }), {
      replace: false,
    });
    const { container } = render(<PendingSendBar mailAccountId={ACCOUNT} onReopen={() => {}} />);
    await waitFor(() => {
      expect(container.querySelector(".pending-send-bar")).toBeNull();
    });
  });
});
