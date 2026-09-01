import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { enqueueMutation } from "./mutation-queue.js";
import { readMailAccounts, readThreadWindow, THREAD_PAGE_SIZE } from "./reads.js";
import { applyMailAccountDelta, applyThreadDelta } from "./server-writes.js";

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `reads-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("readThreadWindow", () => {
  it("serves the top page only, newest first", async () => {
    const threads = Array.from({ length: THREAD_PAGE_SIZE + 10 }, (_, index) =>
      makeThread(`t${String(index).padStart(3, "0")}`, "acct-1", {
        lastMessageAt: minutesAfterEpoch(index),
      }),
    );
    await applyThreadDelta("acct-1", delta({ created: threads }), { replace: false });

    const page = await readThreadWindow("acct-1");

    expect(page.threads).toHaveLength(THREAD_PAGE_SIZE);
    expect(page.threads[0]?.id).toBe(`t${String(THREAD_PAGE_SIZE + 9).padStart(3, "0")}`);
    expect(page.threads.at(-1)?.id).toBe(`t${String(10).padStart(3, "0")}`);
  });

  it("is empty, not broken, for a Mail Account with no window yet", async () => {
    expect(await readThreadWindow("never-synced")).toEqual({ threads: [], complete: true });
  });
});

describe("readThreadWindow — base ⊕ pending overlay (#39)", () => {
  it("renders a queued star instantly, before any server round-trip", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { starred: false })] }),
      { replace: false },
    );

    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, "acct-1");

    const page = await readThreadWindow("acct-1");
    expect(page.threads[0]?.starred).toBe(true);
  });

  it("renders a queued unread/read toggle as unreadCount 0 or every Message, mirroring the backend's bulk semantics", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { unreadCount: 3, messageCount: 5 })] }),
      { replace: false },
    );

    await enqueueMutation({ type: "setRead", threadId: "t1", read: true }, "acct-1");
    expect((await readThreadWindow("acct-1")).threads[0]?.unreadCount).toBe(0);
  });

  it("leaves a Thread with no queued mutation showing its base row, untouched", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t1", "acct-1", { starred: false, lastMessageAt: minutesAfterEpoch(1) }),
          makeThread("t2", "acct-1", { starred: false, lastMessageAt: minutesAfterEpoch(2) }),
        ],
      }),
      { replace: false },
    );

    await enqueueMutation({ type: "setStarred", threadId: "t2", starred: true }, "acct-1");

    const page = await readThreadWindow("acct-1");
    expect(page.threads.find((thread) => thread.id === "t1")?.starred).toBe(false);
    expect(page.threads.find((thread) => thread.id === "t2")?.starred).toBe(true);
  });

  it("reverts automatically once the queued mutation's row is gone — rollback is a row deletion", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { starred: false })] }),
      { replace: false },
    );

    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, "acct-1");
    expect((await readThreadWindow("acct-1")).threads[0]?.starred).toBe(true);

    await localCache().pendingMutations.clear();
    expect((await readThreadWindow("acct-1")).threads[0]?.starred).toBe(false);
  });

  it("hides a Thread the instant archive/trash is queued, before any server round-trip (#42)", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t1", "acct-1", { lastMessageAt: minutesAfterEpoch(1) }),
          makeThread("t2", "acct-1", { lastMessageAt: minutesAfterEpoch(2) }),
        ],
      }),
      { replace: false },
    );

    await enqueueMutation({ type: "archive", threadId: "t1" }, "acct-1");

    const page = await readThreadWindow("acct-1");
    expect(page.threads.map((thread) => thread.id)).toEqual(["t2"]);
  });

  it("trash hides a Thread the same way archive does", async () => {
    await applyThreadDelta("acct-1", delta({ created: [makeThread("t1", "acct-1")] }), {
      replace: false,
    });

    await enqueueMutation({ type: "trash", threadId: "t1" }, "acct-1");

    expect((await readThreadWindow("acct-1")).threads).toEqual([]);
  });

  it("a Thread the Sync Backend already confirmed left the Inbox stays hidden with no pending mutation at all", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { inInbox: false })] }),
      { replace: false },
    );

    expect((await readThreadWindow("acct-1")).threads).toEqual([]);
  });

  it("reverts an archive rollback visibly — the Thread reappears once the rejected mutation's row is gone", async () => {
    await applyThreadDelta("acct-1", delta({ created: [makeThread("t1", "acct-1")] }), {
      replace: false,
    });

    await enqueueMutation({ type: "archive", threadId: "t1" }, "acct-1");
    expect((await readThreadWindow("acct-1")).threads).toEqual([]);

    // A rejected outcome dequeues exactly like an applied one (ADR-0010) —
    // simulated here by clearing the queue directly, as the "reverts
    // automatically" test above does for setStarred.
    await localCache().pendingMutations.clear();
    expect((await readThreadWindow("acct-1")).threads.map((thread) => thread.id)).toEqual(["t1"]);
  });

  it("overlays two different queued intents on the same Thread independently", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [makeThread("t1", "acct-1", { starred: false, unreadCount: 0, messageCount: 2 })],
      }),
      { replace: false },
    );

    await enqueueMutation({ type: "setStarred", threadId: "t1", starred: true }, "acct-1");
    await enqueueMutation({ type: "setRead", threadId: "t1", read: false }, "acct-1");

    const overlaid = (await readThreadWindow("acct-1")).threads[0];
    expect(overlaid?.starred).toBe(true);
    expect(overlaid?.unreadCount).toBe(2);
  });
});

describe("readMailAccounts", () => {
  it("orders by createdAt so the first account is stable across reloads", async () => {
    await applyMailAccountDelta(
      delta({
        created: [
          makeMailAccount("newer", { createdAt: "2026-03-01T00:00:00.000Z" }),
          makeMailAccount("older", { createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
      { replace: false },
    );

    expect((await readMailAccounts()).map((account) => account.id)).toEqual(["older", "newer"]);
  });
});
