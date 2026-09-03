import { labelId } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  delta,
  makeLabel,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { enqueueMutation } from "./mutation-queue.js";
import {
  readLabels,
  readMailAccounts,
  readPreference,
  readThreadWindow,
  THREAD_PAGE_SIZE,
} from "./reads.js";
import {
  applyLabelDelta,
  applyMailAccountDelta,
  applyPreferenceDelta,
  applyThreadDelta,
} from "./server-writes.js";
import { enqueueUserMutation } from "./user-mutation-queue.js";

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

describe("readThreadWindow — Pin (#43)", () => {
  it("sorts Pinned Threads first, regardless of their own date", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("newest", "acct-1", { lastMessageAt: minutesAfterEpoch(10) }),
          makeThread("oldest-pinned", "acct-1", {
            lastMessageAt: minutesAfterEpoch(1),
            pinned: true,
          }),
          makeThread("middle", "acct-1", { lastMessageAt: minutesAfterEpoch(5) }),
        ],
      }),
      { replace: false },
    );

    const page = await readThreadWindow("acct-1");
    expect(page.threads.map((thread) => thread.id)).toEqual(["oldest-pinned", "newest", "middle"]);
  });

  it("renders a queued pin/unpin instantly, before any server round-trip", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({ created: [makeThread("t1", "acct-1", { pinned: false })] }),
      { replace: false },
    );

    await enqueueMutation({ type: "setPinned", threadId: "t1", pinned: true }, "acct-1");
    expect((await readThreadWindow("acct-1")).threads[0]?.pinned).toBe(true);
  });
});

describe("readThreadWindow — Label filter view (#43)", () => {
  it("filters to Threads carrying the given Label id, ordered like the Inbox otherwise", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("work-1", "acct-1", {
            lastMessageAt: minutesAfterEpoch(1),
            labelIds: [labelId("acct-1", "Work")],
          }),
          makeThread("no-label", "acct-1", { lastMessageAt: minutesAfterEpoch(2) }),
          makeThread("work-2", "acct-1", {
            lastMessageAt: minutesAfterEpoch(3),
            labelIds: [labelId("acct-1", "Work")],
          }),
        ],
      }),
      { replace: false },
    );

    const page = await readThreadWindow("acct-1", {
      view: { kind: "label", labelId: labelId("acct-1", "Work") },
    });
    expect(page.threads.map((thread) => thread.id)).toEqual(["work-2", "work-1"]);
  });

  it("renders a queued applyLabel instantly in the matching label view, before any server round-trip", async () => {
    await applyThreadDelta("acct-1", delta({ created: [makeThread("t1", "acct-1")] }), {
      replace: false,
    });

    await enqueueMutation({ type: "applyLabel", threadId: "t1", name: "Work" }, "acct-1");

    const page = await readThreadWindow("acct-1", {
      view: { kind: "label", labelId: labelId("acct-1", "Work") },
    });
    expect(page.threads.map((thread) => thread.id)).toEqual(["t1"]);
  });

  it("drops a Thread from the label view the instant removeLabel is queued", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [makeThread("t1", "acct-1", { labelIds: [labelId("acct-1", "Work")] })],
      }),
      { replace: false },
    );

    await enqueueMutation({ type: "removeLabel", threadId: "t1", name: "Work" }, "acct-1");

    const page = await readThreadWindow("acct-1", {
      view: { kind: "label", labelId: labelId("acct-1", "Work") },
    });
    expect(page.threads).toEqual([]);
  });
});

describe("readLabels", () => {
  it("returns this Mail Account's Labels, name-ordered", async () => {
    await applyLabelDelta(
      "acct-1",
      delta({
        created: [
          makeLabel(labelId("acct-1", "Zeta"), "acct-1", { name: "Zeta" }),
          makeLabel(labelId("acct-1", "Alpha"), "acct-1", { name: "Alpha" }),
        ],
      }),
      { replace: false },
    );

    expect((await readLabels("acct-1")).map((label) => label.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("is empty for a Mail Account with no Labels synced yet", async () => {
    expect(await readLabels("never-synced")).toEqual([]);
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

  it("overlays a queued setSignature/setNotificationsEnabled onto the base row (#54)", async () => {
    await applyMailAccountDelta(
      delta({ created: [makeMailAccount("acct-1", { signature: null })] }),
      { replace: false },
    );

    await enqueueMutation({ type: "setSignature", signature: "Ada" }, "acct-1");
    await enqueueMutation({ type: "setNotificationsEnabled", enabled: false }, "acct-1");

    const [account] = await readMailAccounts();
    expect(account).toMatchObject({ signature: "Ada", notificationsEnabled: false });
  });
});

describe("readPreference — base ⊕ pending overlay (#54)", () => {
  it("falls back to sensible defaults before this Client has ever synced one", async () => {
    expect(await readPreference()).toMatchObject({
      autoAdvanceEnabled: true,
      autoAdvanceDirection: "older",
      undoSendDelaySeconds: 10,
    });
  });

  it("overlays a queued edit onto the default row, offline included", async () => {
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: false, direction: "newer" });

    expect(await readPreference()).toMatchObject({ autoAdvanceEnabled: false });
  });

  it("overlays setAutoAdvance's enabled and direction together, last-queued wins", async () => {
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: true, direction: "older" });
    await enqueueUserMutation({ type: "setAutoAdvance", enabled: false, direction: "newer" });

    expect(await readPreference()).toMatchObject({
      autoAdvanceEnabled: false,
      autoAdvanceDirection: "newer",
    });
  });

  it("overlays onto a base row the Sync Backend already sent", async () => {
    await applyPreferenceDelta(
      delta({
        created: [
          {
            id: "user-1",
            autoAdvanceEnabled: true,
            autoAdvanceDirection: "older",
            undoSendDelaySeconds: 10,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      { replace: false },
    );
    await enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds: 30 });

    expect(await readPreference()).toMatchObject({
      undoSendDelaySeconds: 30,
    });
  });
});
