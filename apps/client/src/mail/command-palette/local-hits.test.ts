import type { NoteBlock, NoteDocument } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { createNote, newNoteId, saveNoteBody } from "../../store/notes.js";
import { setSessionUserId } from "../../store/session.js";
import { searchLocalHits } from "./local-hits.js";

/**
 * `searchLocalHits` (#196, ADR-0023): the generic mechanism's Notes
 * declaration, exercised against a real Local Cache the same way
 * `store/notes.test.ts` exercises the rest of `store/notes.ts` — the
 * `CommandPalette.tsx` integration test covers the Palette's own rendering
 * of what this returns; this file is about the search/eligibility contract
 * itself.
 */

const USER = "user-1";

function paragraph(text: string, id = "b1"): NoteBlock {
  return {
    id,
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `local-hits-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
});

afterEach(async () => {
  localCache().close();
  setSessionUserId(null);
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seedNote(document: NoteDocument): Promise<string> {
  const id = newNoteId();
  await createNote(id);
  await saveNoteBody(id, document);
  return id;
}

describe("searchLocalHits", () => {
  it("is empty for a blank query, without reading the Local Cache", async () => {
    await seedNote([paragraph("Grocery list")]);

    expect(await searchLocalHits("")).toEqual([]);
    expect(await searchLocalHits("   ")).toEqual([]);
  });

  it("matches a Note case-insensitively and names its Palette section", async () => {
    const id = await seedNote([paragraph("Grocery list")]);

    const hits = await searchLocalHits("GROCERY");

    expect(hits).toEqual([
      {
        key: `notes:${id}`,
        section: "Notes",
        title: "Grocery list",
        to: "/notes/$noteId",
        params: { noteId: id },
      },
    ]);
  });

  it("shows the grid's own 'Untitled Note' fallback while still matching a later block's text", async () => {
    const id = await seedNote([paragraph("", "b1"), paragraph("Buy oat milk", "b2")]);

    const hits = await searchLocalHits("oat milk");

    expect(hits[0]).toMatchObject({ title: "Untitled Note", params: { noteId: id } });
  });

  it("excludes a Note that doesn't match", async () => {
    await seedNote([paragraph("Grocery list")]);

    expect(await searchLocalHits("dentist")).toEqual([]);
  });
});
