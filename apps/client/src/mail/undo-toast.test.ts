import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceUndoableAction, resetUndoToastsForTest } from "./undo-toast.js";

interface ToastOptions {
  id: string;
  duration: number;
  action?: { label: string; onClick(): void };
}

const toastFn = vi.fn<(message: string, opts: ToastOptions) => void>();
const dismissFn = vi.fn<(id: string) => void>();

vi.mock("sonner", () => ({
  toast: Object.assign((message: string, opts: ToastOptions) => toastFn(message, opts), {
    dismiss: (id: string) => dismissFn(id),
  }),
}));

/** Every case's own args to the last raised toast for one `id` — `undo-toast.ts` always calls `toast()` fresh, id included, never a mutation of a previous call's options. */
function lastToastFor(id: string): { message: string; opts: ToastOptions } {
  const call = toastFn.mock.calls.filter(([, opts]) => opts.id === id).pop();
  if (!call) throw new Error(`no toast raised for ${id}`);
  const [message, opts] = call;
  return { message, opts };
}

function callsFor(id: string): unknown[] {
  return toastFn.mock.calls.filter(([, opts]) => opts.id === id);
}

beforeEach(() => {
  vi.useFakeTimers();
  toastFn.mockClear();
  dismissFn.mockClear();
  resetUndoToastsForTest();
});

afterEach(() => {
  resetUndoToastsForTest();
  vi.useRealTimers();
});

describe("announceUndoableAction", () => {
  it("raises one toast naming the single action", () => {
    announceUndoableAction("done", vi.fn());

    expect(lastToastFor("undo-toast-done").message).toBe("Done");
  });

  it("coalesces repeats of the same kind into one toast with a running count (#95, ADR-0019)", () => {
    for (let i = 0; i < 8; i++) announceUndoableAction("done", vi.fn());

    expect(lastToastFor("undo-toast-done").message).toBe("8 done");
    // One call per raise (Sonner's own `id` replaces in place), never a
    // stack of eight — the acceptance line's own "one toast" bar.
    expect(callsFor("undo-toast-done")).toHaveLength(8);
  });

  it("Undo reverses every folded-in action, not just the last one", () => {
    const undoA = vi.fn();
    const undoB = vi.fn();
    announceUndoableAction("done", undoA);
    announceUndoableAction("done", undoB);

    lastToastFor("undo-toast-done").opts.action?.onClick();

    expect(undoA).toHaveBeenCalledTimes(1);
    expect(undoB).toHaveBeenCalledTimes(1);
  });

  it("gives each action kind its own toast", () => {
    announceUndoableAction("done", vi.fn());
    announceUndoableAction("trash", vi.fn());

    expect(lastToastFor("undo-toast-done").message).toBe("Done");
    expect(lastToastFor("undo-toast-trash").message).toBe("Moved to trash");
  });

  it("stacks at most two distinct kinds — a third evicts the oldest still-open toast", () => {
    announceUndoableAction("done", vi.fn());
    announceUndoableAction("trash", vi.fn());
    announceUndoableAction("snooze", vi.fn());

    expect(dismissFn).toHaveBeenCalledWith("undo-toast-done");
  });

  it("keeps the evicted kind's Undo alive even without a visible toast", () => {
    announceUndoableAction("done", vi.fn());
    announceUndoableAction("trash", vi.fn());
    announceUndoableAction("block", vi.fn()); // evicts "done"'s toast

    // A second "done" within the window re-raises its toast and still
    // reverses both of its folded-in actions, including the one from
    // before it was evicted.
    const undoDoneAgain = vi.fn();
    announceUndoableAction("done", undoDoneAgain);
    lastToastFor("undo-toast-done").opts.action?.onClick();

    expect(undoDoneAgain).toHaveBeenCalledTimes(1);
  });

  it("clears the bucket once its window elapses — Undo no longer does anything", () => {
    const undo = vi.fn();
    announceUndoableAction("done", undo);

    vi.advanceTimersByTime(10_000);
    announceUndoableAction("done", vi.fn());

    // The count restarted at 1 rather than continuing from the expired bucket.
    expect(lastToastFor("undo-toast-done").message).toBe("Done");
    expect(undo).not.toHaveBeenCalled();
  });

  it("slides the window forward on every new action of the same kind", () => {
    announceUndoableAction("done", vi.fn());
    vi.advanceTimersByTime(9_000);
    announceUndoableAction("done", vi.fn()); // still within the first window

    vi.advanceTimersByTime(9_000); // 18s since the first action, but only 9s since the second
    expect(lastToastFor("undo-toast-done").message).toBe("2 done");
  });
});
