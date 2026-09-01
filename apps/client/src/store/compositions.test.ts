import type { ComposeSave } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_COMPOSE_CONTENT,
  isComposeContentEmpty,
  listQueuedComposeSaves,
  resolveComposeSaveOutcomes,
  saveComposition,
  subscribeComposeConflicts,
  toWireComposeSave,
} from "./compositions.js";
import { localCache, openLocalCache } from "./local-cache.js";

/** `expect(x).toBeDefined()` narrows in an `if`, not through the assertion itself — this does both in one line. */
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

/**
 * ADR-0014's own acceptance line: a Composition is durable in the Local
 * Cache from the first keystroke, autosave coalesces to last-write-wins per
 * Composition (never replayed one save per keystroke), and a version this
 * Client no longer holds is a `conflict`, never a silent overwrite.
 */

const ACCOUNT = "acct-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `compositions-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("saveComposition", () => {
  it("creates nothing for an unmodified, still-empty composer (ADR-0012: 'lazily on first content')", async () => {
    await saveComposition("comp-1", ACCOUNT, EMPTY_COMPOSE_CONTENT);

    expect(await localCache().compositions.get("comp-1")).toBeUndefined();
    expect(await listQueuedComposeSaves(ACCOUNT)).toEqual([]);
  });

  it("still writes through an existing row edited back down to blank", async () => {
    await saveComposition("comp-1", ACCOUNT, {
      ...EMPTY_COMPOSE_CONTENT,
      subject: "typed, then deleted",
    });
    await saveComposition("comp-1", ACCOUNT, EMPTY_COMPOSE_CONTENT);

    const row = await localCache().compositions.get("comp-1");
    expect(row?.subject).toBe("");
    const queued = await listQueuedComposeSaves(ACCOUNT);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.subject).toBe("");
  });

  it("creates the Composition row lazily on the first save", async () => {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "Hi" });

    const row = await localCache().compositions.get("comp-1");
    expect(row).toMatchObject({
      id: "comp-1",
      mailAccountId: ACCOUNT,
      status: "draft",
      subject: "Hi",
      version: 0,
    });
  });

  it("survives a reload: the row is readable from a freshly reopened handle on the same database", async () => {
    const name = names[names.length - 1] as string;
    await saveComposition("comp-1", ACCOUNT, {
      ...EMPTY_COMPOSE_CONTENT,
      subject: "Draft in progress",
    });

    // "Reload" — a new Client boot reopening the same on-disk database, not
    // the same in-memory handle.
    await openLocalCache({ name, schemaVersion: 1 });

    const row = await localCache().compositions.get("comp-1");
    expect(row?.subject).toBe("Draft in progress");
  });

  it("coalesces: three autosaves in a row before any flush leave exactly one queued save, with the latest content", async () => {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "v1" });
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "v2" });
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "v3" });

    const queued = await listQueuedComposeSaves(ACCOUNT);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.subject).toBe("v3");
  });

  it("keeps each Composition's queue independent", async () => {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "first draft" });
    await saveComposition("comp-2", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "second draft" });

    const queued = await listQueuedComposeSaves(ACCOUNT);
    expect(queued.map((save) => save.subject).sort()).toEqual(["first draft", "second draft"]);
  });
});

describe("isComposeContentEmpty", () => {
  it("is true for the untouched default document", () => {
    expect(isComposeContentEmpty(EMPTY_COMPOSE_CONTENT)).toBe(true);
  });

  it("is false once there is a subject, a recipient, or typed text", () => {
    expect(isComposeContentEmpty({ ...EMPTY_COMPOSE_CONTENT, subject: "Hi" })).toBe(false);
    expect(
      isComposeContentEmpty({
        ...EMPTY_COMPOSE_CONTENT,
        to: [{ name: null, address: "a@b.test" }],
      }),
    ).toBe(false);
    expect(
      isComposeContentEmpty({
        ...EMPTY_COMPOSE_CONTENT,
        document: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
        },
      }),
    ).toBe(false);
  });

  it("is false for a meaningful contentless node, like an inserted image", () => {
    expect(
      isComposeContentEmpty({
        ...EMPTY_COMPOSE_CONTENT,
        document: { type: "doc", content: [{ type: "image", attrs: { src: "cid:1" } }] },
      }),
    ).toBe(false);
  });
});

describe("toWireComposeSave", () => {
  it("reads the Composition's current local version, not one captured when the save was queued", async () => {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "v1" });
    const [firstQueued] = await listQueuedComposeSaves(ACCOUNT);
    expect((await toWireComposeSave(defined(firstQueued))).version).toBe(0);

    // A save lands and bumps the local version, independent of this file's
    // own coalescing — the sync-round applying an outcome would do this.
    const row = await localCache().compositions.get("comp-1");
    await localCache().compositions.put({ ...defined(row), version: 1 });

    // A newer, already-coalesced save queued *after* that version bump must
    // be sent against the now-current version, not whatever was true when
    // it was first queued.
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "v2" });
    const [secondQueued] = await listQueuedComposeSaves(ACCOUNT);
    expect((await toWireComposeSave(defined(secondQueued))).version).toBe(1);
  });
});

describe("resolveComposeSaveOutcomes", () => {
  async function flushOnce(subject: string): Promise<ComposeSave> {
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject });
    const [queued] = await listQueuedComposeSaves(ACCOUNT);
    return toWireComposeSave(defined(queued));
  }

  it("dequeues an applied save and bumps the local version", async () => {
    const save = await flushOnce("v1");
    await resolveComposeSaveOutcomes(
      ACCOUNT,
      [save],
      [{ id: save.id, saveId: save.saveId, status: "applied", version: 1 }],
    );

    expect(await listQueuedComposeSaves(ACCOUNT)).toEqual([]);
    expect((await localCache().compositions.get("comp-1"))?.version).toBe(1);
  });

  it("leaves a superseded save queued: a newer coalesced save must not be dropped by a stale outcome", async () => {
    const save = await flushOnce("v1");
    // Coalesces over the still-in-flight save before its outcome returns.
    await saveComposition("comp-1", ACCOUNT, { ...EMPTY_COMPOSE_CONTENT, subject: "v2" });

    await resolveComposeSaveOutcomes(
      ACCOUNT,
      [save],
      [{ id: save.id, saveId: save.saveId, status: "applied", version: 1 }],
    );

    const queued = await listQueuedComposeSaves(ACCOUNT);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.subject).toBe("v2");
  });

  it("on conflict, keeps the local edit and re-queues it against the corrected version — never a silent overwrite", async () => {
    const save = await flushOnce("my unsaved edit");

    const seen: unknown[] = [];
    const unsubscribe = subscribeComposeConflicts((conflict) => seen.push(conflict));
    await resolveComposeSaveOutcomes(
      ACCOUNT,
      [save],
      [{ id: save.id, saveId: save.saveId, status: "conflict", version: 5 }],
    );
    unsubscribe();

    expect(seen).toEqual([{ mailAccountId: ACCOUNT, compositionId: "comp-1" }]);

    const row = await localCache().compositions.get("comp-1");
    expect(row?.subject).toBe("my unsaved edit"); // never destroyed
    expect(row?.version).toBe(5); // the corrected version this Client now knows

    const requeued = await listQueuedComposeSaves(ACCOUNT);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]?.subject).toBe("my unsaved edit");
    expect((await toWireComposeSave(defined(requeued[0]))).version).toBe(5);
  });

  it("does not bump the local version on a rejected outcome", async () => {
    const save = await flushOnce("v1");
    await resolveComposeSaveOutcomes(
      ACCOUNT,
      [save],
      [{ id: save.id, saveId: save.saveId, status: "rejected", version: 0, reason: "not_a_draft" }],
    );
    expect((await localCache().compositions.get("comp-1"))?.version).toBe(0);
    expect(await listQueuedComposeSaves(ACCOUNT)).toEqual([]);
  });
});
