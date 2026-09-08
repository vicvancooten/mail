import type { NoteDocument, NoteSave } from "@mail/shared";
import { EMPTY_NOTE_DOCUMENT, labelId } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "./local-cache.js";
import {
  createNote,
  deleteNote,
  labelNote,
  listQueuedNoteSaves,
  newNoteId,
  pinNote,
  readNote,
  readNotes,
  resolveNoteSaveOutcomes,
  saveNoteBody,
  toWireNoteSave,
  unlabelNote,
  unpinNote,
} from "./notes.js";
import { setSessionUserId } from "./session.js";
import { listQueuedUserMutations } from "./user-mutation-queue.js";

/**
 * #192's own acceptance line: a Note's id is a client-minted ULID, present
 * before any server round trip; create/label ride the User-scoped
 * Optimistic Action queue with real inverses (ADR-0019); body edits ride
 * `pendingNoteSaves` — one queued save per Note, a newer edit replacing a
 * queued older one rather than stacking.
 */

const USER = "user-1";

/** `expect(x).toBeDefined()` narrows in an `if`, not through the assertion itself — this does both in one line. */
function defined<T>(value: T | undefined | null): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
}

const requestSyncNow = vi.fn();
vi.mock("../sync/sync-loop.js", () => ({
  requestSyncNow: () => requestSyncNow(),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `notes-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  requestSyncNow.mockClear();
});

afterEach(async () => {
  localCache().close();
  setSessionUserId(null);
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function paragraph(text: string): NoteDocument {
  return [
    {
      id: "b1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text, styles: {} }],
      children: [],
    },
  ];
}

describe("newNoteId", () => {
  it("mints a fresh id, offline-derivable before any content exists", () => {
    const id = newNoteId();
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
    expect(newNoteId()).not.toBe(id);
  });
});

describe("createNote", () => {
  it("writes the durable row optimistically, empty document and no Labels", async () => {
    const id = newNoteId();

    await createNote(id);

    const row = defined(await readNote(id));
    expect(row).toMatchObject({ id, userId: USER, labelIds: [] });
    expect(row.document).toEqual(EMPTY_NOTE_DOCUMENT);
  });

  it("enqueues a createNote intent on the User-scoped queue", async () => {
    const id = newNoteId();

    await createNote(id);

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({ type: "createNote", noteId: id });
    expect(requestSyncNow).toHaveBeenCalled();
  });

  it("does nothing before the session User is known", async () => {
    setSessionUserId(null);
    const id = newNoteId();

    await createNote(id);

    expect(await readNote(id)).toBeUndefined();
    expect(await listQueuedUserMutations()).toEqual([]);
  });
});

describe("deleteNote", () => {
  it("removes the local row and any queued body save, and enqueues the inverse intent", async () => {
    const id = newNoteId();
    await createNote(id);
    await saveNoteBody(id, paragraph("typed"));

    await deleteNote(id);

    expect(await readNote(id)).toBeUndefined();
    expect(await listQueuedNoteSaves()).toEqual([]);
    const queued = await listQueuedUserMutations();
    // `createNote` and `deleteNote` are a genuine inverse pair (ADR-0019):
    // both still queued cancels the pair away rather than shipping either.
    expect(queued).toEqual([]);
  });

  it("still enqueues deleteNote when the create already flushed", async () => {
    const id = newNoteId();
    await createNote(id);
    await listQueuedUserMutations().then((queued) =>
      localCache().pendingUserMutations.bulkDelete(queued.map((mutation) => mutation.id)),
    );

    await deleteNote(id);

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.intent).toEqual({ type: "deleteNote", noteId: id });
  });
});

describe("labelNote / unlabelNote", () => {
  it("applies a Label optimistically and enqueues the intent", async () => {
    const id = newNoteId();
    await createNote(id);

    await labelNote(id, "Work");

    const row = defined(await readNote(id));
    expect(row.labelIds).toEqual([labelId(USER, "Work")]);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "labelNote",
      noteId: id,
      name: "Work",
    });
  });

  it("cancels a still-queued labelNote when unlabelNote follows for the same name", async () => {
    const id = newNoteId();
    await createNote(id);
    await listQueuedUserMutations().then((queued) =>
      localCache().pendingUserMutations.bulkDelete(queued.map((mutation) => mutation.id)),
    );

    await labelNote(id, "Work");
    await unlabelNote(id, "Work");

    const row = defined(await readNote(id));
    expect(row.labelIds).toEqual([]);
    expect(await listQueuedUserMutations()).toEqual([]);
  });

  it("keeps Labels for different Notes as independent queued intents", async () => {
    const a = newNoteId();
    const b = newNoteId();
    await createNote(a);
    await createNote(b);
    await listQueuedUserMutations().then((queued) =>
      localCache().pendingUserMutations.bulkDelete(queued.map((mutation) => mutation.id)),
    );

    await labelNote(a, "Work");
    await labelNote(b, "Work");

    const queued = await listQueuedUserMutations();
    expect(queued).toHaveLength(2);
  });
});

describe("pinNote / unpinNote (#193)", () => {
  it("pins optimistically and enqueues the intent", async () => {
    const id = newNoteId();
    await createNote(id);

    await pinNote(id);

    const row = defined(await readNote(id));
    expect(row.pinned).toBe(true);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "pinNote",
      noteId: id,
    });
  });

  it("unpins optimistically and enqueues the inverse intent", async () => {
    const id = newNoteId();
    await createNote(id);
    await pinNote(id);
    await listQueuedUserMutations().then((queued) =>
      localCache().pendingUserMutations.bulkDelete(queued.map((mutation) => mutation.id)),
    );

    await unpinNote(id);

    const row = defined(await readNote(id));
    expect(row.pinned).toBe(false);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "unpinNote",
      noteId: id,
    });
  });

  it("cancels a still-queued pinNote when unpinNote follows for the same Note", async () => {
    const id = newNoteId();
    await createNote(id);
    await listQueuedUserMutations().then((queued) =>
      localCache().pendingUserMutations.bulkDelete(queued.map((mutation) => mutation.id)),
    );

    await pinNote(id);
    await unpinNote(id);

    const row = defined(await readNote(id));
    expect(row.pinned).toBe(false);
    expect(await listQueuedUserMutations()).toEqual([]);
  });

  it("a brand-new Note starts unpinned", async () => {
    const id = newNoteId();

    await createNote(id);

    expect((await readNote(id))?.pinned).toBe(false);
  });
});

describe("saveNoteBody (the noteSaves channel, #192, ADR-0023)", () => {
  it("writes the durable row and queues one save, keyed by Note id", async () => {
    const id = newNoteId();
    await createNote(id);

    await saveNoteBody(id, paragraph("hello"));

    expect((await readNote(id))?.document).toEqual(paragraph("hello"));
    const queued = await listQueuedNoteSaves();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.noteId).toBe(id);
    expect(queued[0]?.document).toEqual(paragraph("hello"));
  });

  it("leaves pinned untouched — a body save is never a structural edit", async () => {
    const id = newNoteId();
    await createNote(id);
    await pinNote(id);

    await saveNoteBody(id, paragraph("typed while pinned"));

    expect((await readNote(id))?.pinned).toBe(true);
  });

  it("replaces a still-queued save rather than stacking a second one", async () => {
    const id = newNoteId();
    await createNote(id);

    await saveNoteBody(id, paragraph("first"));
    const firstSaveId = (await listQueuedNoteSaves())[0]?.saveId;
    await saveNoteBody(id, paragraph("second"));

    const queued = await listQueuedNoteSaves();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.document).toEqual(paragraph("second"));
    expect(queued[0]?.saveId).not.toBe(firstSaveId);
  });

  it("keeps a different Note's queued save independent", async () => {
    const a = newNoteId();
    const b = newNoteId();
    await createNote(a);
    await createNote(b);

    await saveNoteBody(a, paragraph("a"));
    await saveNoteBody(b, paragraph("b"));

    expect(await listQueuedNoteSaves()).toHaveLength(2);
  });
});

describe("toWireNoteSave", () => {
  it("carries the Note id, saveId and document straight through — no version, unlike a Composition save", async () => {
    const id = newNoteId();
    await createNote(id);
    await saveNoteBody(id, paragraph("hi"));
    const [pending] = await listQueuedNoteSaves();

    const wire = toWireNoteSave(defined(pending));

    expect(wire).toEqual({ id, saveId: defined(pending).saveId, document: paragraph("hi") });
  });
});

describe("resolveNoteSaveOutcomes", () => {
  it("dequeues a save once its outcome (always applied, #192) lands", async () => {
    const id = newNoteId();
    await createNote(id);
    await saveNoteBody(id, paragraph("hi"));
    const [pending] = await listQueuedNoteSaves();
    const wire: NoteSave = toWireNoteSave(defined(pending));

    await resolveNoteSaveOutcomes([wire], [{ id, saveId: wire.saveId, status: "applied" }]);

    expect(await listQueuedNoteSaves()).toEqual([]);
  });

  it("leaves a newer, already-coalesced save queued rather than dequeuing it on a stale outcome", async () => {
    const id = newNoteId();
    await createNote(id);
    await saveNoteBody(id, paragraph("first"));
    const staleWire = toWireNoteSave(defined((await listQueuedNoteSaves())[0]));
    await saveNoteBody(id, paragraph("second")); // coalesces the queued row before the round trip answers

    await resolveNoteSaveOutcomes(
      [staleWire],
      [{ id, saveId: staleWire.saveId, status: "applied" }],
    );

    const queued = await listQueuedNoteSaves();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.document).toEqual(paragraph("second"));
  });
});

describe("readNotes", () => {
  it("lists every held Note, most recently updated first", async () => {
    const a = newNoteId();
    const b = newNoteId();
    await createNote(a);
    await createNote(b);
    // Bump b's updatedAt ahead of a's without depending on real clock ordering.
    const row = defined(await readNote(b));
    await localCache().notes.put({ ...row, updatedAt: "2099-01-01T00:00:00.000Z" });

    expect((await readNotes()).map((note) => note.id)).toEqual([b, a]);
  });
});
