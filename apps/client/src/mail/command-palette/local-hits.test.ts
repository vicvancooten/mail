import type { NoteBlock, NoteDocument } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCache, openLocalCache } from "../../store/local-cache.js";
import { createNote, newNoteId, saveNoteBody } from "../../store/notes.js";
import { setSessionUserId } from "../../store/session.js";
import {
  completeTask,
  createTask,
  createTaskList,
  newTaskId,
  newTaskListId,
  saveTaskBody,
  trashTask,
} from "../../store/tasks.js";
import { searchLocalHits, seeAllRouteFor } from "./local-hits.js";

/**
 * `searchLocalHits` (#196, ADR-0023): the generic mechanism's Notes and
 * Tasks (#262) declarations, exercised against a real Local Cache the same
 * way `store/notes.test.ts`/`store/tasks.test.ts` exercise the rest of their
 * own stores — the `CommandPalette.tsx` integration test covers the
 * Palette's own rendering of what this returns; this file is about the
 * search/eligibility contract itself.
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

async function seedTask(
  title: string,
  document: NoteDocument = [],
  taskListId?: string,
): Promise<string> {
  const listId =
    taskListId ??
    (await (async () => {
      const id = newTaskListId();
      await createTaskList(id, "My List");
      return id;
    })());
  const id = newTaskId();
  await createTask(id, listId, null, title);
  if (document.length > 0) await saveTaskBody(id, document);
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

describe("searchLocalHits — Tasks (#262)", () => {
  it("matches a Task's title and names its own Palette section", async () => {
    const id = await seedTask("Buy groceries");

    const hits = await searchLocalHits("groceries");

    expect(hits).toEqual([
      {
        key: `tasks:${id}`,
        section: "Tasks",
        title: "Buy groceries",
        to: "/tasks/$taskId",
        params: { taskId: id },
      },
    ]);
  });

  it("matches a Task's flattened body text, not only its title", async () => {
    const id = await seedTask("Errands", [paragraph("Pick up dry cleaning")]);

    const hits = await searchLocalHits("dry cleaning");

    expect(hits[0]).toMatchObject({ title: "Errands", params: { taskId: id } });
  });

  it("marks a completed Task and ranks it below open ones", async () => {
    const listId = newTaskListId();
    await createTaskList(listId, "Shared list");
    const openId = await seedTask("Open sprocket task", [], listId);
    const doneId = await seedTask("Done sprocket task", [], listId);
    await completeTask(doneId);

    const hits = await searchLocalHits("sprocket");

    expect(hits.map((hit) => hit.params.taskId)).toEqual([openId, doneId]);
    expect(hits.find((hit) => hit.params.taskId === doneId)).toMatchObject({ badge: "Done" });
    expect(hits.find((hit) => hit.params.taskId === openId)?.badge).toBeUndefined();
  });

  it("excludes a soft-deleted Task", async () => {
    const id = await seedTask("Trashed sprocket task");
    await trashTask(id);

    expect(await searchLocalHits("sprocket")).toEqual([]);
  });

  it("shows a fallback title for a Task with no title text", async () => {
    const id = await seedTask("", [paragraph("Untitled but findable")]);

    const hits = await searchLocalHits("findable");

    expect(hits[0]).toMatchObject({ title: "(untitled)", params: { taskId: id } });
  });
});

describe("seeAllRouteFor (#262)", () => {
  it("narrows the Tasks App with the query, for the Tasks section", () => {
    expect(seeAllRouteFor("Tasks", "sprocket")).toEqual({
      to: "/tasks",
      search: { q: "sprocket" },
    });
  });

  it("has nothing to narrow into for the Notes section", () => {
    expect(seeAllRouteFor("Notes", "sprocket")).toBeNull();
  });
});
