import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAddressBook,
  readAddressBooks,
  readDefaultAddressBook,
  readLocalAddressBook,
  setDefaultAddressBook,
} from "./address-books.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { listQueuedUserMutations } from "./user-mutation-queue.js";

const requestSyncNow = vi.fn();
vi.mock("../sync/sync-loop.js", () => ({
  requestSyncNow: () => requestSyncNow(),
}));

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `address-books-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("readLocalAddressBook", () => {
  it("is undefined before any Address Book has synced", async () => {
    expect(await readLocalAddressBook()).toBeUndefined();
  });

  it("finds the Local one among a mix of Origins", async () => {
    await localCache().addressBooks.bulkPut([
      {
        id: "mirrored-1",
        name: "Work",
        origin: { kind: "connectedAccount", connectedAccountId: "ca-1" },
        mirrored: true,
        isDefault: false,
        capabilityTableId: "google",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "local-1",
        name: "My Contacts",
        origin: { kind: "local" },
        mirrored: false,
        isDefault: true,
        capabilityTableId: "local",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const book = await readLocalAddressBook();
    expect(book?.id).toBe("local-1");
  });
});

describe("readAddressBooks (#211)", () => {
  it("lists every Address Book across every Origin, name-ordered", async () => {
    await localCache().addressBooks.bulkPut([
      {
        id: "mirrored-1",
        name: "Work",
        origin: { kind: "connectedAccount", connectedAccountId: "ca-1" },
        mirrored: true,
        isDefault: false,
        capabilityTableId: "google",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "local-1",
        name: "My Contacts",
        origin: { kind: "local" },
        mirrored: false,
        isDefault: true,
        capabilityTableId: "local",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const books = await readAddressBooks();
    expect(books.map((book) => book.id)).toEqual(["local-1", "mirrored-1"]);
  });

  it("is empty before anything has synced", async () => {
    expect(await readAddressBooks()).toEqual([]);
  });
});

describe("readAddressBook (#211)", () => {
  it("reads one Address Book by id", async () => {
    await localCache().addressBooks.put({
      id: "local-1",
      name: "My Contacts",
      origin: { kind: "local" },
      mirrored: false,
      isDefault: true,
      capabilityTableId: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect((await readAddressBook("local-1"))?.name).toBe("My Contacts");
    expect(await readAddressBook("missing")).toBeUndefined();
    expect(await readAddressBook(null)).toBeUndefined();
  });
});

describe("readDefaultAddressBook / setDefaultAddressBook (#211)", () => {
  beforeEach(async () => {
    await localCache().addressBooks.bulkPut([
      {
        id: "local-1",
        name: "My Contacts",
        origin: { kind: "local" },
        mirrored: false,
        isDefault: true,
        capabilityTableId: "local",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "mirrored-1",
        name: "Google Contacts",
        origin: { kind: "connectedAccount", connectedAccountId: "ca-1" },
        mirrored: true,
        isDefault: false,
        capabilityTableId: "google",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    requestSyncNow.mockClear();
  });

  it("reads whichever row carries isDefault", async () => {
    expect((await readDefaultAddressBook())?.id).toBe("local-1");
  });

  it("moves isDefault to the named book, and off every other, both locally and on the queue", async () => {
    await setDefaultAddressBook("mirrored-1");

    expect((await readDefaultAddressBook())?.id).toBe("mirrored-1");
    expect((await readAddressBook("local-1"))?.isDefault).toBe(false);
    const queued = await listQueuedUserMutations();
    expect(queued.map((mutation) => mutation.intent)).toContainEqual({
      type: "setDefaultAddressBook",
      addressBookId: "mirrored-1",
    });
    expect(requestSyncNow).toHaveBeenCalled();
  });

  it("falls back to the Local one while nothing carries isDefault yet", async () => {
    await localCache().addressBooks.toCollection().modify({ isDefault: false });
    expect((await readDefaultAddressBook())?.id).toBe("local-1");
  });
});
