import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  delta,
  makeMailAccount,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { localCache, openLocalCache } from "./local-cache.js";
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
