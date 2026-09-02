import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStaleThreadNotification } from "../pwa/close-stale-notifications.js";
import {
  delta,
  makeComposition,
  makeLabel,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { pinThreadIntoCache } from "./cache-pins.js";
import { EMPTY_COMPOSE_CONTENT, saveComposition, sendComposition } from "./compositions.js";
import { listWindowKey } from "./db.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { readLabels, readThreadWindow } from "./reads.js";
import {
  applyCompositionDelta,
  applyLabelDelta,
  applyMailAccountDelta,
  applyThreadDelta,
  compositionTokenKey,
  flushScheduledWindowTrims,
  getSyncToken,
  labelTokenKey,
  listCachedMailAccountIds,
  MAIL_ACCOUNT_TOKEN_KEY,
  pruneOrphanedMailAccountData,
  THREAD_WINDOW_FLOOR,
  THREAD_WINDOW_HIGH_WATER,
  threadTokenKey,
} from "./server-writes.js";

vi.mock("../pwa/close-stale-notifications.js", () => ({
  closeStaleThreadNotification: vi.fn(async () => {}),
}));

/**
 * The bounded working set (ADR-0009) as it is actually enforced: admission
 * on the write path, trimming back to the floor, and the never-evictable set.
 */

const ACCOUNT = "acct-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `server-writes-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

/** Threads dated one minute apart: index 0 oldest, index n-1 newest. */
function ladder(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) =>
    makeThread(`t${String(offset + index).padStart(6, "0")}`, ACCOUNT, {
      lastMessageAt: minutesAfterEpoch(offset + index),
    }),
  );
}

async function windowRow() {
  return localCache().listWindows.get(listWindowKey(ACCOUNT, "all"));
}

describe("applyThreadDelta", () => {
  it("stores a bootstrap page newest-first and advances the state token", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(3), newState: "state-7" }), {
      replace: false,
    });

    const page = await readThreadWindow(ACCOUNT);
    expect(page.threads.map((thread) => thread.id)).toEqual(["t000002", "t000001", "t000000"]);
    expect(page.complete).toBe(true);
    expect(await getSyncToken(threadTokenKey(ACCOUNT))).toBe("state-7");
  });

  it("removes destroyed Threads and their cache pin", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(2) }), { replace: false });
    await pinThreadIntoCache("t000000");

    await applyThreadDelta(ACCOUNT, delta({ destroyed: ["t000000"] }), { replace: false });

    const page = await readThreadWindow(ACCOUNT);
    expect(page.threads.map((thread) => thread.id)).toEqual(["t000001"]);
    expect(await localCache().cachePins.get("t000000")).toBeUndefined();
  });

  it("replaces rather than merges on the first page of a reset replay", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(2) }), { replace: false });

    await applyThreadDelta(
      ACCOUNT,
      delta({ created: [makeThread("fresh", ACCOUNT)], reset: true, hasMore: true }),
      { replace: true },
    );
    // A later page of the same replay carries `reset` too and must merge.
    await applyThreadDelta(
      ACCOUNT,
      delta({
        created: [makeThread("also-fresh", ACCOUNT, { lastMessageAt: minutesAfterEpoch(9) })],
        reset: true,
      }),
      { replace: false },
    );

    const page = await readThreadWindow(ACCOUNT);
    expect(page.threads.map((thread) => thread.id).toSorted()).toEqual(["also-fresh", "fresh"]);
  });

  it("keeps an already-held Thread up to date even when its date moves below the window", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(THREAD_WINDOW_HIGH_WATER + 1) }), {
      replace: false,
    });
    const newest = `t${String(THREAD_WINDOW_HIGH_WATER).padStart(6, "0")}`;

    await flushScheduledWindowTrims();

    // Its newest Message was deleted, so the rollup's date walks backwards
    // past the cutoff. Ignoring the update would leave a stale row on screen.
    await applyThreadDelta(
      ACCOUNT,
      delta({
        updated: [
          makeThread(newest, ACCOUNT, { subject: "Rewound", lastMessageAt: minutesAfterEpoch(0) }),
        ],
      }),
      { replace: false },
    );

    expect((await localCache().threads.get(newest))?.subject).toBe("Rewound");
  });
});

/**
 * Trimming itself runs off the idle-scheduled sweep `scheduleWindowTrim`
 * queues rather than inline (ADR-0009, `server-writes.ts#trimWindow`), so
 * every test below that asserts trimmed state calls `flushScheduledWindowTrims`
 * — the test seam that runs a queued sweep right now instead of waiting on a
 * real idle tick.
 */
describe("the bounded working set", () => {
  it("trims to the floor once the window passes its high water, and says the list is truncated", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(THREAD_WINDOW_HIGH_WATER + 1) }), {
      replace: false,
    });
    await flushScheduledWindowTrims();

    const page = await readThreadWindow(ACCOUNT, { limit: THREAD_WINDOW_HIGH_WATER + 1 });
    expect(page.threads).toHaveLength(THREAD_WINDOW_FLOOR);
    expect(page.complete).toBe(false);
    // Contiguous from newest: the floor's worth of newest Threads, nothing older.
    expect(page.threads[0]?.id).toBe(`t${String(THREAD_WINDOW_HIGH_WATER).padStart(6, "0")}`);
    expect(await localCache().threads.count()).toBe(THREAD_WINDOW_FLOOR);
  });

  it("does not trim inline — the sync write settles before any sweep runs", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(THREAD_WINDOW_HIGH_WATER + 1) }), {
      replace: false,
    });

    // Every row landed; nothing has been evicted yet.
    expect(await localCache().threads.count()).toBe(THREAD_WINDOW_HIGH_WATER + 1);

    await flushScheduledWindowTrims();

    expect(await localCache().threads.count()).toBe(THREAD_WINDOW_FLOOR);
  });

  // 1,500 Threads across 3 separate deltas (each running its own eviction
  // pass) is comfortably under vitest's default 5s timeout locally, but not
  // on GitHub Actions' slower shared runners against fake-indexeddb — bump
  // it rather than the suite's global default.
  it(
    "holds the floor even against a Thread count far past it",
    async () => {
      for (let page = 0; page < 3; page++) {
        await applyThreadDelta(ACCOUNT, delta({ created: ladder(500, page * 500) }), {
          replace: false,
        });
      }
      await flushScheduledWindowTrims();

      const page = await readThreadWindow(ACCOUNT, { limit: 5_000 });
      expect(page.threads.length).toBeGreaterThanOrEqual(THREAD_WINDOW_FLOOR);
      expect(page.threads.length).toBeLessThanOrEqual(THREAD_WINDOW_HIGH_WATER);
    },
    20_000,
  );

  it("ignores a delta for a Thread below the window rather than growing the cache", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(THREAD_WINDOW_HIGH_WATER + 1) }), {
      replace: false,
    });
    await flushScheduledWindowTrims();
    const before = await localCache().threads.count();

    await applyThreadDelta(
      ACCOUNT,
      delta({
        created: [makeThread("ancient", ACCOUNT, { lastMessageAt: minutesAfterEpoch(-1) })],
      }),
      { replace: false },
    );

    expect(await localCache().threads.get("ancient")).toBeUndefined();
    expect(await localCache().threads.count()).toBe(before);
  });

  it("keeps an opened Thread in the entity cache when it ages out of the window", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(10) }), { replace: false });
    await pinThreadIntoCache("t000000");

    await applyThreadDelta(ACCOUNT, delta({ created: ladder(THREAD_WINDOW_HIGH_WATER + 1, 100) }), {
      replace: false,
    });
    await flushScheduledWindowTrims();

    // Retained as an entity, but out of the list window: a pin keeps a
    // Thread readable, it does not put it back in the list.
    expect(await localCache().threads.get("t000000")).toBeDefined();
    const page = await readThreadWindow(ACCOUNT, { limit: 5_000 });
    expect(page.threads.map((thread) => thread.id)).not.toContain("t000000");
  });

  it("keeps a Thread a queued Optimistic Action references", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(10) }), { replace: false });
    await localCache().pendingMutations.put({
      id: "01JQUEUED",
      mailAccountId: ACCOUNT,
      createdAt: minutesAfterEpoch(0),
      referencedThreadIds: ["t000001"],
      intent: { type: "setStarred", threadId: "t000001", starred: true },
    });

    await applyThreadDelta(ACCOUNT, delta({ created: ladder(THREAD_WINDOW_HIGH_WATER + 1, 100) }), {
      replace: false,
    });
    await flushScheduledWindowTrims();

    expect(await localCache().threads.get("t000001")).toBeDefined();
    // Its unreferenced neighbour went, so this is retention, not a failed trim.
    expect(await localCache().threads.get("t000002")).toBeUndefined();
  });

  it("reopens the window on a reset replay", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(THREAD_WINDOW_HIGH_WATER + 1) }), {
      replace: false,
    });
    await flushScheduledWindowTrims();
    expect((await windowRow())?.complete).toBe(false);

    await applyThreadDelta(ACCOUNT, delta({ created: ladder(3), reset: true }), { replace: true });

    const row = await windowRow();
    expect(row?.complete).toBe(true);
    expect(row?.oldestHeldSort).toBeNull();
  });

  describe("closing stale notifications on \\Seen (#53, ADR-0015)", () => {
    beforeEach(() => {
      vi.mocked(closeStaleThreadNotification).mockClear();
    });

    it("closes the notification for a Thread whose delta update lands with unreadCount at zero", async () => {
      await applyThreadDelta(ACCOUNT, delta({ created: [makeThread("t1", ACCOUNT)] }), {
        replace: false,
      });

      await applyThreadDelta(
        ACCOUNT,
        delta({ updated: [makeThread("t1", ACCOUNT, { unreadCount: 0 })] }),
        { replace: false },
      );

      expect(closeStaleThreadNotification).toHaveBeenCalledTimes(1);
      expect(closeStaleThreadNotification).toHaveBeenCalledWith("t1");
    });

    it("does not touch a Thread whose update still has unread mail", async () => {
      await applyThreadDelta(ACCOUNT, delta({ created: [makeThread("t1", ACCOUNT)] }), {
        replace: false,
      });

      await applyThreadDelta(
        ACCOUNT,
        delta({ updated: [makeThread("t1", ACCOUNT, { unreadCount: 2 })] }),
        { replace: false },
      );

      expect(closeStaleThreadNotification).not.toHaveBeenCalled();
    });

    it("does not fire for a newly created (backfilled) Thread — it never had a notification to begin with", async () => {
      await applyThreadDelta(
        ACCOUNT,
        delta({ created: [makeThread("t1", ACCOUNT, { unreadCount: 0 })] }),
        { replace: false },
      );

      expect(closeStaleThreadNotification).not.toHaveBeenCalled();
    });
  });
});

describe("applyMailAccountDelta", () => {
  it("stores accounts and reports them as what to ask Thread deltas about", async () => {
    await applyMailAccountDelta(
      delta({ created: [makeMailAccount("acct-1"), makeMailAccount("acct-2")] }),
      { replace: false },
    );

    expect((await listCachedMailAccountIds()).toSorted()).toEqual(["acct-1", "acct-2"]);
    expect(await getSyncToken(MAIL_ACCOUNT_TOKEN_KEY)).toBe("state-1");
  });

  it("cascades a destroyed Mail Account to its Threads, Labels, window, pins and tokens", async () => {
    await applyMailAccountDelta(delta({ created: [makeMailAccount(ACCOUNT)] }), { replace: false });
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(3) }), { replace: false });
    await applyLabelDelta(ACCOUNT, delta({ created: [makeLabel("l1", ACCOUNT)] }), {
      replace: false,
    });
    await pinThreadIntoCache("t000000");

    await applyMailAccountDelta(delta({ destroyed: [ACCOUNT] }), { replace: false });

    expect(await localCache().threads.count()).toBe(0);
    expect(await localCache().labels.count()).toBe(0);
    expect(await localCache().cachePins.count()).toBe(0);
    expect(await windowRow()).toBeUndefined();
    expect(await getSyncToken(threadTokenKey(ACCOUNT))).toBeNull();
    expect(await getSyncToken(labelTokenKey(ACCOUNT))).toBeNull();
  });
});

describe("applyLabelDelta (#43)", () => {
  it("stores Labels and advances the state token", async () => {
    await applyLabelDelta(
      ACCOUNT,
      delta({ created: [makeLabel("l1", ACCOUNT, { name: "Work" })], newState: "label-state-1" }),
      { replace: false },
    );

    expect((await readLabels(ACCOUNT)).map((label) => label.name)).toEqual(["Work"]);
    expect(await getSyncToken(labelTokenKey(ACCOUNT))).toBe("label-state-1");
  });

  it("replaces rather than merges on the first page of a reset replay", async () => {
    await applyLabelDelta(ACCOUNT, delta({ created: [makeLabel("stale", ACCOUNT)] }), {
      replace: false,
    });

    await applyLabelDelta(ACCOUNT, delta({ created: [makeLabel("fresh", ACCOUNT)], reset: true }), {
      replace: true,
    });

    expect((await readLabels(ACCOUNT)).map((label) => label.id)).toEqual(["fresh"]);
  });

  it("removes destroyed Labels", async () => {
    await applyLabelDelta(ACCOUNT, delta({ created: [makeLabel("l1", ACCOUNT)] }), {
      replace: false,
    });

    await applyLabelDelta(ACCOUNT, delta({ destroyed: ["l1"] }), { replace: false });

    expect(await readLabels(ACCOUNT)).toEqual([]);
  });
});

describe("pruneOrphanedMailAccountData", () => {
  it("drops data for an account a reset replay no longer lists", async () => {
    await applyMailAccountDelta(
      delta({ created: [makeMailAccount(ACCOUNT), makeMailAccount("acct-2")] }),
      { replace: false },
    );
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(2) }), { replace: false });

    await applyMailAccountDelta(delta({ created: [makeMailAccount("acct-2")], reset: true }), {
      replace: true,
    });
    await pruneOrphanedMailAccountData();

    expect(await localCache().threads.count()).toBe(0);
    expect(await windowRow()).toBeUndefined();
  });

  it("does nothing before the MailAccount collection has ever synced", async () => {
    await applyThreadDelta(ACCOUNT, delta({ created: ladder(2) }), { replace: false });

    await pruneOrphanedMailAccountData();

    // An empty `mailAccounts` table means "not synced yet", not "no accounts".
    expect(await localCache().threads.count()).toBe(2);
  });
});

/**
 * `Composition` (#46): the one delta whose rows the Client also writes, so
 * the only one with a merge rule. See `applyCompositionDelta`'s own doc
 * comment — send state is always the server's, content is the Client's while
 * an autosave is still queued.
 */
describe("applyCompositionDelta", () => {
  it("adopts a Composition wholesale when this Client has nothing queued for it", async () => {
    await applyCompositionDelta(
      ACCOUNT,
      delta({ created: [makeComposition("comp-1", ACCOUNT, { subject: "From another device" })] }),
      { replace: false },
    );

    const row = await localCache().compositions.get("comp-1");
    expect(row?.subject).toBe("From another device");
    expect(row?.status).toBe("draft");
    expect(await getSyncToken(compositionTokenKey(ACCOUNT))).toBe("state-1");
  });

  it("takes the server's send state onto a row this Client is still editing, but never its content", async () => {
    await saveComposition("comp-1", ACCOUNT, {
      ...EMPTY_COMPOSE_CONTENT,
      subject: "typed here, not yet flushed",
    });

    await applyCompositionDelta(
      ACCOUNT,
      delta({
        updated: [
          makeComposition("comp-1", ACCOUNT, {
            subject: "the server's older copy",
            status: "pending",
            submitAfter: "2026-06-01T12:00:10.000Z",
            version: 4,
          }),
        ],
      }),
      { replace: false },
    );

    const row = await localCache().compositions.get("comp-1");
    // ADR-0012's rule: text the server has not seen is never overwritten.
    expect(row?.subject).toBe("typed here, not yet flushed");
    // The countdown, though, is the server's — that is what makes a Pending
    // Send visible on this device (ADR-0007).
    expect(row?.status).toBe("pending");
    expect(row?.submitAfter).toBe("2026-06-01T12:00:10.000Z");
    expect(row?.version).toBe(4);
  });

  it("adopts the server's content once the queued save has flushed — the cancel-on-another-device path", async () => {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "local" });
    await localCache().pendingComposeSaves.delete("comp-1"); // flushed

    await applyCompositionDelta(
      ACCOUNT,
      delta({ updated: [makeComposition("comp-1", ACCOUNT, { subject: "cancelled elsewhere" })] }),
      { replace: false },
    );

    expect((await localCache().compositions.get("comp-1"))?.subject).toBe("cancelled elsewhere");
  });

  it("clears a stale local send marker once the server's status is terminal", async () => {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "s" });
    await sendComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "s" });
    expect((await localCache().compositions.get("comp-1"))?.sendState).toBe("queued");

    await applyCompositionDelta(
      ACCOUNT,
      delta({ updated: [makeComposition("comp-1", ACCOUNT, { status: "sent" })] }),
      { replace: false },
    );
    expect((await localCache().compositions.get("comp-1"))?.sendState).toBeNull();
  });

  it("drops a retired Composition and anything still queued against it", async () => {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "s" });

    await applyCompositionDelta(ACCOUNT, delta({ destroyed: ["comp-1"] }), { replace: false });

    expect(await localCache().compositions.get("comp-1")).toBeUndefined();
    expect(await localCache().pendingComposeSaves.get("comp-1")).toBeUndefined();
  });
});
