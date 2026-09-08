import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyMailAccountDelta, applyThreadDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import { delta, makeMailAccount, makeThread } from "../test-support/mail-fixtures.js";
import { ThreadLinkPickerDialog } from "./ThreadLinkPickerDialog.js";

/**
 * `store/reads.ts#readRecentThreadsForLinking` (and its Account-Scope-free,
 * Trash/Junk-excluding shape) already has its own coverage
 * (`store/reads.test.ts`) — this file is only what the dialog itself owns:
 * resolving open/closed, the filter box, and calling `onPick`.
 */

const USER = "user-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `thread-link-picker-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  cleanup();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

async function seedThreads(): Promise<void> {
  await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-1")] }), { replace: false });
  await applyThreadDelta(
    "acct-1",
    delta({
      created: [
        makeThread("t1", "acct-1", {
          subject: "Quarterly numbers",
          participants: [{ name: "Ada Lovelace", address: "ada@example.test" }],
        }),
        makeThread("t2", "acct-1", {
          subject: "Lunch plans",
          participants: [{ name: "Grace Hopper", address: "grace@example.test" }],
        }),
      ],
    }),
    { replace: false },
  );
}

describe("ThreadLinkPickerDialog (#195)", () => {
  it("renders nothing while closed", () => {
    render(<ThreadLinkPickerDialog open={false} onOpenChange={vi.fn()} onPick={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every cached Thread once open", async () => {
    await seedThreads();

    render(<ThreadLinkPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);

    expect(await screen.findByText("Quarterly numbers")).toBeDefined();
    expect(screen.getByText("Lunch plans")).toBeDefined();
  });

  it("filters by subject or participant, case-insensitively", async () => {
    await seedThreads();

    render(<ThreadLinkPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText("Quarterly numbers");

    fireEvent.change(screen.getByRole("textbox", { name: "Search Threads" }), {
      target: { value: "grace" },
    });

    expect(screen.getByText("Lunch plans")).toBeDefined();
    expect(screen.queryByText("Quarterly numbers")).toBeNull();
  });

  it("calls onPick with the chosen Thread", async () => {
    await seedThreads();
    const onPick = vi.fn();

    render(<ThreadLinkPickerDialog open onOpenChange={vi.fn()} onPick={onPick} />);
    await screen.findByText("Quarterly numbers");

    fireEvent.click(screen.getByText("Quarterly numbers"));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toMatchObject({ id: "t1", subject: "Quarterly numbers" });
  });

  it("says so when nothing matches the filter, without claiming there are no Threads at all", async () => {
    await seedThreads();

    render(<ThreadLinkPickerDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);
    await screen.findByText("Quarterly numbers");

    fireEvent.change(screen.getByRole("textbox", { name: "Search Threads" }), {
      target: { value: "nothing matches this" },
    });

    expect(await screen.findByText("No Threads match.")).toBeDefined();
  });
});
