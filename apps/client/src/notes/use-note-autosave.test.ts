import type { NoteDocument } from "@mail/shared";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNote, listQueuedNoteSaves, newNoteId, readNote } from "../store/index.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { setSessionUserId } from "../store/session.js";
import { AUTOSAVE_DEBOUNCE_MS, useNoteAutosave } from "./use-note-autosave.js";

/**
 * #192's own acceptance line: body edits ride the `documentSaves` channel with
 * the same `AUTOSAVE_DEBOUNCE_MS = 400` local debounce Composer.tsx already
 * uses — `Composer.test.tsx`'s own "autosaves ... a short debounce after
 * typing" test is this file's template, real timers and `waitFor` rather
 * than fake ones (a Dexie/fake-indexeddb round trip does not mix well with
 * mocked timers).
 */

const USER = "user-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `use-note-autosave-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  cleanup();
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

describe("useNoteAutosave", () => {
  it(`writes the durable row and queues one save, ${AUTOSAVE_DEBOUNCE_MS}ms after the last call`, async () => {
    const id = newNoteId();
    await createNote(id);
    const { result } = renderHook(() => useNoteAutosave(id));

    result.current.onChange(paragraph("hello"));

    await waitFor(
      async () => {
        expect((await readNote(id))?.document).toEqual(paragraph("hello"));
      },
      { timeout: 3000 },
    );
    expect(await listQueuedNoteSaves()).toHaveLength(1);
  });

  it("reschedules rather than firing twice for a second call inside the debounce window", async () => {
    const id = newNoteId();
    await createNote(id);
    const { result } = renderHook(() => useNoteAutosave(id));

    result.current.onChange(paragraph("first"));
    result.current.onChange(paragraph("second"));

    await waitFor(
      async () => {
        expect((await readNote(id))?.document).toEqual(paragraph("second"));
      },
      { timeout: 3000 },
    );
    // One queued save, not two — coalescing, not stacking.
    expect(await listQueuedNoteSaves()).toHaveLength(1);
  });

  it("clears the pending timer on unmount — a leftover debounce must never fire against a closed Note", async () => {
    const id = newNoteId();
    await createNote(id);
    const { result, unmount } = renderHook(() => useNoteAutosave(id));

    result.current.onChange(paragraph("typed then closed"));
    unmount();

    // Long past the debounce window: nothing should have landed.
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 200));
    expect(await listQueuedNoteSaves()).toEqual([]);
  });

  describe("flush (#193)", () => {
    it("writes immediately, without waiting for the debounce — the Note dialog's own close path", async () => {
      const id = newNoteId();
      await createNote(id);
      const { result } = renderHook(() => useNoteAutosave(id));

      result.current.onChange(paragraph("typed then closed"));
      result.current.flush();

      await waitFor(async () => {
        expect((await readNote(id))?.document).toEqual(paragraph("typed then closed"));
      });
      expect(await listQueuedNoteSaves()).toHaveLength(1);
    });

    it("does nothing when nothing is pending", async () => {
      const id = newNoteId();
      await createNote(id);
      const { result } = renderHook(() => useNoteAutosave(id));

      result.current.flush();

      expect(await listQueuedNoteSaves()).toEqual([]);
    });

    it("a flushed change doesn't also fire again once the (now-cleared) debounce would have elapsed", async () => {
      const id = newNoteId();
      await createNote(id);
      const { result } = renderHook(() => useNoteAutosave(id));

      result.current.onChange(paragraph("first"));
      result.current.flush();
      result.current.onChange(paragraph("second, still queued"));

      // Past the original debounce window: the flushed write didn't leave a
      // stray timer that would re-save the first document over the second.
      await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 200));
      expect((await readNote(id))?.document).toEqual(paragraph("second, still queued"));
    });
  });
});
