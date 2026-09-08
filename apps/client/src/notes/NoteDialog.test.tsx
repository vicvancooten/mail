import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { createNote, pinNote, readNote } from "../store/notes.js";
import { setSessionUserId } from "../store/session.js";
import { NoteDialog } from "./NoteDialog.js";

/**
 * `NoteDialog` takes no router dependency of its own (`noteId`/`onClose` are
 * plain props) — `router/NoteDialogRoute.tsx` is the thin router-aware
 * wrapper, and the grid/dialog-over-grid *routing* behaviour itself
 * (opening on click, deep links, the bad-id redirect) is covered by
 * `app-shell-integration.test.tsx`, the same split `MailRoute.tsx`/
 * `MailSection.tsx` already draw. Simulating real typing into a BlockNote
 * editor under jsdom isn't reliable (ProseMirror's own view doesn't react to
 * a raw `fireEvent.input` the way a plain `<input>` does — `NoteEditor.test.tsx`
 * only asserts on render for the same reason), so autosave's actual write
 * path is `use-note-autosave.test.ts`'s job; this file covers what's
 * `NoteDialog`'s own to own — resolving the Note, the close paths, and Pin.
 */

const USER = "user-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `note-dialog-test-${counter++}`;
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

describe("NoteDialog (#193)", () => {
  it("renders nothing until the Note resolves, then the live editor", async () => {
    const id = "note-1";
    await createNote(id);

    render(<NoteDialog noteId={id} onClose={vi.fn()} />);

    expect(await screen.findByRole("dialog")).toBeDefined();
    await waitFor(() => {
      expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
    });
  });

  it("renders no editor for a Note that hasn't resolved (or doesn't exist)", () => {
    render(<NoteDialog noteId="does-not-exist" onClose={vi.fn()} />);

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it("Esc calls onClose — the same Radix onOpenChange every close path shares", async () => {
    const id = "note-1";
    await createNote(id);
    const onClose = vi.fn();

    render(<NoteDialog noteId={id} onClose={onClose} />);
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("the close control calls onClose", async () => {
    const id = "note-1";
    await createNote(id);
    const onClose = vi.fn();

    render(<NoteDialog noteId={id} onClose={onClose} />);
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("the Pin control toggles the Note's pinned state from inside the dialog", async () => {
    const id = "note-1";
    await createNote(id);

    render(<NoteDialog noteId={id} onClose={vi.fn()} />);
    const pinButton = await screen.findByRole("button", { name: "Pin note" });

    fireEvent.click(pinButton);

    await waitFor(async () => {
      expect((await readNote(id))?.pinned).toBe(true);
    });
    expect(await screen.findByRole("button", { name: "Unpin note" })).toBeDefined();
  });

  it("shows an already-pinned Note as pinned, and unpins it", async () => {
    const id = "note-1";
    await createNote(id);
    await pinNote(id);

    render(<NoteDialog noteId={id} onClose={vi.fn()} />);
    const unpinButton = await screen.findByRole("button", { name: "Unpin note" });

    fireEvent.click(unpinButton);

    await waitFor(async () => {
      expect((await readNote(id))?.pinned).toBe(false);
    });
  });
});
