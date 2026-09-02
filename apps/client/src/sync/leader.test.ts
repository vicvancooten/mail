import { describe, expect, it } from "vitest";
import { createFakeLockManager } from "../test-support/fake-lock-manager.js";
import { claimLeadership } from "./leader.js";

/** A task that runs until the leader is released, recording that it ran. */
function trackedTask(log: string[], label: string) {
  return (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      log.push(label);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("claimLeadership", () => {
  it("runs exactly one task while the lock is held", async () => {
    const locks = createFakeLockManager();
    const log: string[] = [];

    const first = claimLeadership(trackedTask(log, "first"), { locks });
    claimLeadership(trackedTask(log, "second"), { locks });
    await settle();

    expect(log).toEqual(["first"]);
    first.release();
  });

  it("hands leadership to a waiting tab when the leader releases", async () => {
    const locks = createFakeLockManager();
    const log: string[] = [];

    const first = claimLeadership(trackedTask(log, "first"), { locks });
    const second = claimLeadership(trackedTask(log, "second"), { locks });
    await settle();

    first.release();
    await settle();

    expect(log).toEqual(["first", "second"]);
    second.release();
  });

  it("withdraws a claim that is still queued", async () => {
    const locks = createFakeLockManager();
    const log: string[] = [];

    const first = claimLeadership(trackedTask(log, "first"), { locks });
    const second = claimLeadership(trackedTask(log, "second"), { locks });
    await settle();

    second.release();
    first.release();
    await settle();

    expect(log).toEqual(["first"]);
  });

  it("runs the task outright when the host has no Web Locks", async () => {
    const log: string[] = [];

    const handle = claimLeadership(trackedTask(log, "only"), { locks: null });
    await settle();

    expect(log).toEqual(["only"]);
    handle.release();
  });
});
