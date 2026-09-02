import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { readSearchPrefilter } from "../../store/reads.js";
import { threadSortKey } from "../../store/thread-sort-key.js";
import { makeThread } from "../../test-support/mail-fixtures.js";

let counter = 0;
const names: string[] = [];

async function seed(...threads: ReturnType<typeof makeThread>[]): Promise<void> {
  const db = localCache();
  await db.threads.bulkPut(
    threads.map((thread) => ({ ...thread, sortKey: threadSortKey(thread) })),
  );
}

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function open(): Promise<void> {
  const name = `search-prefilter-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
}

describe("readSearchPrefilter", () => {
  it("matches subject, sender, and snippet case-insensitively", async () => {
    await open();
    await seed(
      makeThread("t1", "acct-1", { subject: "Invoice March" }),
      makeThread("t2", "acct-1", { subject: "Unrelated" }),
    );

    const results = await readSearchPrefilter("acct-1", { text: "invoice" });

    expect(results.map((t) => t.id)).toEqual(["t1"]);
  });

  it("is a substring match, not a second ranker — order stays date-descending", async () => {
    await open();
    await seed(
      makeThread("older", "acct-1", {
        subject: "report",
        lastMessageAt: "2026-06-01T10:00:00.000Z",
      }),
      makeThread("newer", "acct-1", {
        subject: "report",
        lastMessageAt: "2026-06-02T10:00:00.000Z",
      }),
    );

    const results = await readSearchPrefilter("acct-1", { text: "report" });

    expect(results.map((t) => t.id)).toEqual(["newer", "older"]);
  });

  it("honors has:attachment", async () => {
    await open();
    await seed(
      makeThread("with", "acct-1", { subject: "x", hasAttachments: true }),
      makeThread("without", "acct-1", { subject: "x", hasAttachments: false }),
    );

    const results = await readSearchPrefilter("acct-1", { text: "", hasAttachment: true });

    expect(results.map((t) => t.id)).toEqual(["with"]);
  });

  it("scopes in:inbox to inInbox — the only folder the Local Cache can honor", async () => {
    await open();
    await seed(
      makeThread("inbox", "acct-1", { subject: "x", inInbox: true }),
      makeThread("archived", "acct-1", { subject: "x", inInbox: false }),
    );

    const results = await readSearchPrefilter("acct-1", { text: "", folder: "inbox" });

    expect(results.map((t) => t.id)).toEqual(["inbox"]);
  });

  it("reflects a queued triage action instantly, offline included", async () => {
    await open();
    await seed(makeThread("t1", "acct-1", { subject: "report", hasAttachments: true }));
    await localCache().pendingMutations.put({
      id: "01JMUT",
      mailAccountId: "acct-1",
      createdAt: "2026-06-01T12:00:00.000Z",
      referencedThreadIds: ["t1"],
      intent: { type: "archive", threadId: "t1" },
    });

    const results = await readSearchPrefilter("acct-1", { text: "", folder: "inbox" });

    expect(results).toEqual([]);
  });
});
