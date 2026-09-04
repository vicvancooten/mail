import type { ComposeSave } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discardComposition,
  EMPTY_COMPOSE_CONTENT,
  isComposeContentEmpty,
  listQueuedComposeSaves,
  readDraftCompositions,
  requestCancelSend,
  resolveComposeSaveOutcomes,
  resolveDiscardOutcomes,
  resolveSendOutcomes,
  saveComposition,
  sendComposition,
  subscribeComposeConflicts,
  toWireComposeSave,
  undiscardComposition,
  undoSecondsRemaining,
} from "./compositions.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { listQueuedMutations, resolveMutationOutcomes } from "./mutation-queue.js";

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

  it("on conflict, keeps the local edit, notifies with the corrected version, and never auto-retries", async () => {
    const save = await flushOnce("my unsaved edit");

    const seen: unknown[] = [];
    const unsubscribe = subscribeComposeConflicts((conflict) => seen.push(conflict));
    await resolveComposeSaveOutcomes(
      ACCOUNT,
      [save],
      [{ id: save.id, saveId: save.saveId, status: "conflict", version: 5 }],
    );
    unsubscribe();

    expect(seen).toEqual([{ mailAccountId: ACCOUNT, compositionId: "comp-1", version: 5 }]);

    const row = await localCache().compositions.get("comp-1");
    expect(row?.subject).toBe("my unsaved edit"); // never destroyed
    expect(row?.version).toBe(5); // the corrected version this Client now knows

    // No automatic retry: a guaranteed-to-succeed re-save against the
    // corrected version would silently clobber the other device's write —
    // the one failure ADR-0012 says is worth code to prevent. Nothing is
    // queued until the User explicitly picks "Keep mine" or "Use theirs".
    expect(await listQueuedComposeSaves(ACCOUNT)).toEqual([]);
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

/**
 * The send path's Client side (#46, ADR-0007/ADR-0014): a send is a durable
 * queued intent plus a final autosave, the countdown is only ever the
 * server's, and a cancel that arrives while the send is still queued locally
 * never reaches the Sync Backend at all.
 */
describe("sendComposition", () => {
  const CONTENT = {
    ...EMPTY_COMPOSE_CONTENT,
    subject: "Lunch",
    to: [{ name: null, address: "ada@example.test" }],
  };

  it("writes the final content, queues the intent, and marks the send in flight", async () => {
    await sendComposition("comp-1", ACCOUNT, CONTENT);

    // Both halves of a Send press ride the same round trip.
    const save = defined(await localCache().pendingComposeSaves.get("comp-1"));
    expect(save.subject).toBe("Lunch");
    const queued = await listQueuedMutations(ACCOUNT);
    expect(queued.map((mutation) => mutation.intent)).toEqual([
      { type: "sendComposition", compositionId: "comp-1" },
    ]);

    const row = defined(await localCache().compositions.get("comp-1"));
    expect(row.sendState).toBe("queued");
    // Never a locally-invented deadline: ADR-0014's countdown starts only
    // when the Sync Backend accepts the send.
    expect(row.submitAfter).toBeNull();
    expect(row.status).toBe("draft");
  });

  it("clears the in-flight marker once the send is applied", async () => {
    await sendComposition("comp-1", ACCOUNT, CONTENT);
    await resolveSendOutcomes([
      { intent: { type: "sendComposition", compositionId: "comp-1" }, status: "applied" },
    ]);
    expect((await localCache().compositions.get("comp-1"))?.sendState).toBeNull();
  });
});

describe("requestCancelSend", () => {
  const CONTENT = {
    ...EMPTY_COMPOSE_CONTENT,
    subject: "Lunch",
    to: [{ name: null, address: "ada@example.test" }],
  };

  it("coalesces away a send still sitting in the queue — the Sync Backend never hears about it", async () => {
    await sendComposition("comp-1", ACCOUNT, CONTENT);
    await requestCancelSend("comp-1", ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
    const row = defined(await localCache().compositions.get("comp-1"));
    expect(row.sendState).toBeNull();
    expect(row.status).toBe("draft");
    expect(row.subject).toBe("Lunch"); // the Draft is intact, ready to reopen
  });

  it("queues a real cancel once the send has already flushed", async () => {
    await sendComposition("comp-1", ACCOUNT, CONTENT);
    await resolveMutationOutcomes(
      ACCOUNT,
      (await listQueuedMutations(ACCOUNT)).map((mutation) => ({
        id: mutation.id,
        intent: mutation.intent,
      })),
      [{ id: defined((await listQueuedMutations(ACCOUNT))[0]).id, status: "applied" }],
    );

    await requestCancelSend("comp-1", ACCOUNT);
    expect((await listQueuedMutations(ACCOUNT)).map((mutation) => mutation.intent)).toEqual([
      { type: "cancelSend", compositionId: "comp-1" },
    ]);
    expect((await localCache().compositions.get("comp-1"))?.sendState).toBe("cancelling");
  });

  it("records a cancel that lost the race, so 'too late' is on the screen rather than in a toast", async () => {
    await sendComposition("comp-1", ACCOUNT, CONTENT);
    await resolveSendOutcomes([
      {
        intent: { type: "cancelSend", compositionId: "comp-1" },
        status: "rejected",
        reason: "too_late",
      },
    ]);
    expect((await localCache().compositions.get("comp-1"))?.sendState).toBe("too_late");
  });
});

describe("discardComposition (#101)", () => {
  const CONTENT = {
    ...EMPTY_COMPOSE_CONTENT,
    subject: "Half a thought",
  };

  it("flips the row to discarded and queues the intent, optimistically", async () => {
    await saveComposition("comp-1", ACCOUNT, CONTENT, { force: true });

    await discardComposition("comp-1", ACCOUNT);

    const row = defined(await localCache().compositions.get("comp-1"));
    expect(row.status).toBe("discarded");
    expect(row.subject).toBe("Half a thought"); // content survives the flip, for Undo to restore
    expect((await listQueuedMutations(ACCOUNT)).map((mutation) => mutation.intent)).toEqual([
      { type: "discardComposition", compositionId: "comp-1" },
    ]);
  });

  it("reverts the optimistic flip when the Sync Backend rejects the discard", async () => {
    await saveComposition("comp-1", ACCOUNT, CONTENT, { force: true });
    await discardComposition("comp-1", ACCOUNT);

    await resolveDiscardOutcomes([
      {
        intent: { type: "discardComposition", compositionId: "comp-1" },
        status: "rejected",
        reason: "not_a_draft",
      },
    ]);

    expect((await localCache().compositions.get("comp-1"))?.status).toBe("draft");
  });

  it("needs no reversion for an applied outcome — the Composition delta confirms it", async () => {
    await saveComposition("comp-1", ACCOUNT, CONTENT, { force: true });
    await discardComposition("comp-1", ACCOUNT);

    await resolveDiscardOutcomes([
      { intent: { type: "discardComposition", compositionId: "comp-1" }, status: "applied" },
    ]);

    expect((await localCache().compositions.get("comp-1"))?.status).toBe("discarded");
  });
});

describe("undiscardComposition (#95, ADR-0019)", () => {
  it("coalesces away a discard still sitting in the queue — the Sync Backend never hears about it", async () => {
    await saveComposition("comp-1", ACCOUNT, EMPTY_COMPOSE_CONTENT, { force: true });
    await discardComposition("comp-1", ACCOUNT);

    await undiscardComposition("comp-1", ACCOUNT);

    expect(await listQueuedMutations(ACCOUNT)).toEqual([]);
    expect((await localCache().compositions.get("comp-1"))?.status).toBe("draft");
  });

  it("queues the real inverse once the discard has already flushed", async () => {
    await saveComposition("comp-1", ACCOUNT, EMPTY_COMPOSE_CONTENT, { force: true });
    await discardComposition("comp-1", ACCOUNT);
    const queued = defined((await listQueuedMutations(ACCOUNT))[0]);
    await resolveMutationOutcomes(ACCOUNT, [queued], [{ id: queued.id, status: "applied" }]);

    await undiscardComposition("comp-1", ACCOUNT);

    expect((await listQueuedMutations(ACCOUNT)).map((mutation) => mutation.intent)).toEqual([
      { type: "undiscardComposition", compositionId: "comp-1" },
    ]);
    expect((await localCache().compositions.get("comp-1"))?.status).toBe("draft");
  });
});

describe("readDraftCompositions — Account Scope (#73, #101)", () => {
  it("merges every named account's Drafts into one newest-first list", async () => {
    await saveComposition(
      "comp-1",
      "acct-1",
      { ...EMPTY_COMPOSE_CONTENT, subject: "older" },
      { force: true },
    );
    await saveComposition(
      "comp-2",
      "acct-2",
      { ...EMPTY_COMPOSE_CONTENT, subject: "newer" },
      { force: true },
    );
    // Bump comp-2's updatedAt ahead of comp-1's without depending on real clock ordering.
    const row = defined(await localCache().compositions.get("comp-2"));
    await localCache().compositions.put({ ...row, updatedAt: "2099-01-01T00:00:00.000Z" });

    const drafts = await readDraftCompositions(["acct-1", "acct-2"]);

    expect(drafts.map((draft) => draft.subject)).toEqual(["newer", "older"]);
  });

  it("excludes a discarded Composition — the whole of what 'Delete removes the row' means client-side", async () => {
    await saveComposition("comp-1", ACCOUNT, EMPTY_COMPOSE_CONTENT, { force: true });
    await discardComposition("comp-1", ACCOUNT);

    expect(await readDraftCompositions([ACCOUNT])).toEqual([]);
  });

  it("returns nothing for an empty Scope", async () => {
    expect(await readDraftCompositions([])).toEqual([]);
  });
});

describe("undoSecondsRemaining", () => {
  const base = {
    id: "comp-1",
    mailAccountId: ACCOUNT,
    status: "pending" as const,
    subject: "Lunch",
    document: EMPTY_COMPOSE_CONTENT.document,
    to: [],
    cc: [],
    bcc: [],
    inReplyTo: null,
    references: [],
    version: 1,
    sendError: null,
    sentAt: null,
    sendState: null,
    attachments: [],
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
  };

  it("counts down from the server's absolute deadline, rounding up so the last second is shown", () => {
    const row = { ...base, submitAfter: "2026-06-01T12:00:10.000Z" };
    expect(undoSecondsRemaining(row, Date.parse("2026-06-01T12:00:00.000Z"))).toBe(10);
    expect(undoSecondsRemaining(row, Date.parse("2026-06-01T12:00:09.400Z"))).toBe(1);
  });

  it("never goes negative once the deadline has passed", () => {
    const row = { ...base, submitAfter: "2026-06-01T12:00:10.000Z" };
    expect(undoSecondsRemaining(row, Date.parse("2026-06-01T12:00:30.000Z"))).toBe(0);
  });

  it("is null with no server-issued deadline — an offline send has nothing honest to count", () => {
    expect(undoSecondsRemaining({ ...base, submitAfter: null })).toBeNull();
  });
});
