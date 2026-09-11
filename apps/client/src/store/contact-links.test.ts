import type { ContactLink } from "@mail/shared";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAddressBook, makeContact } from "../test-support/mail-fixtures.js";
import {
  duplicateCandidatesInScope,
  linkContacts,
  newContactLinkId,
  readContactLinks,
  readLinkedContactGroup,
  setLinkedContactFront,
  unlinkContact,
} from "./contact-links.js";
import { localCache, openLocalCache } from "./local-cache.js";
import { setSessionUserId } from "./session.js";

/**
 * The Client half of Linked Contacts (#222) — the optimistic write, which has
 * to land in a state the Sync Backend can actually confirm
 * (`store/contact-links.ts`'s own doc comment on why the union happens here
 * too), plus the queued intent that goes with it.
 */
const USER = "user-1";
let counter = 0;
const names: string[] = [];

const LOCAL = makeAddressBook("book-local", { isDefault: true });
const GOOGLE = makeAddressBook("book-google", {
  name: "Google Contacts",
  capabilityTableId: "google",
  isDefault: false,
  origin: { kind: "connectedAccount", connectedAccountId: "acct-1" },
});

function email(value: string) {
  return { id: `e-${value}`, type: "home", value, primary: false };
}

beforeEach(async () => {
  const name = `contact-links-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  await localCache().addressBooks.bulkPut([LOCAL, GOOGLE]);
});

afterEach(async () => {
  cleanupSession();
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

function cleanupSession() {
  localCache().close();
  setSessionUserId(null);
}

async function queuedIntents() {
  return (await localCache().pendingUserMutations.toArray()).map((row) => row.intent);
}

describe("linkContacts (#222)", () => {
  beforeEach(async () => {
    await localCache().contacts.bulkPut([
      makeContact("a", LOCAL.id, { emails: [email("ada@example.com")] }),
      makeContact("b", GOOGLE.id, { emails: [email("ada@example.com")] }),
      makeContact("c", "book-third", { emails: [email("ada@example.com")] }),
    ]);
  });

  it("writes one link optimistically and queues the intent", async () => {
    await linkContacts("link-1", "a", "b");

    const links = await readContactLinks();
    expect(links).toHaveLength(1);
    expect([...(links[0]?.contactIds ?? [])].sort()).toEqual(["a", "b"]);
    expect(await queuedIntents()).toEqual([
      { type: "linkContacts", linkId: "link-1", contactId: "a", otherContactId: "b" },
    ]);
  });

  it("changes no Contact row — the whole point of a link (ADR-0026)", async () => {
    const before = await localCache().contacts.toArray();
    await linkContacts("link-1", "a", "b");
    expect(await localCache().contacts.toArray()).toEqual(before);
  });

  it("unions into the link a side already belongs to rather than writing a second", async () => {
    await linkContacts("link-1", "a", "b");
    await linkContacts("link-2", "b", "c");

    const links = await readContactLinks();
    expect(links).toHaveLength(1);
    expect([...(links[0]?.contactIds ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect(links[0]?.id).toBe("link-1");
  });

  it("resolves one person from either record's id, front first", async () => {
    await linkContacts("link-1", "a", "b");

    const fromGoogle = await readLinkedContactGroup("b");
    // The Default Address Book fronts the card (ADR-0026), even when the
    // dialog was opened on the other record.
    expect(fromGoogle?.front.id).toBe("a");
    expect(fromGoogle?.members.map((member) => member.id)).toEqual(["a", "b"]);
  });

  it("ignores a link of a record to itself", async () => {
    await linkContacts("link-1", "a", "a");
    expect(await readContactLinks()).toEqual([]);
    expect(await queuedIntents()).toEqual([]);
  });

  it("mints a distinct link id each time", () => {
    expect(newContactLinkId()).not.toBe(newContactLinkId());
  });
});

describe("unlinkContact (#222)", () => {
  beforeEach(async () => {
    await localCache().contacts.bulkPut([
      makeContact("a", LOCAL.id),
      makeContact("b", GOOGLE.id),
      makeContact("c", "book-third"),
    ]);
  });

  it("restores two separate people by dropping the link outright", async () => {
    await linkContacts("link-1", "a", "b");
    await localCache().pendingUserMutations.clear();

    await unlinkContact("b");

    expect(await readContactLinks()).toEqual([]);
    expect((await readLinkedContactGroup("a"))?.link).toBeNull();
    expect((await readLinkedContactGroup("b"))?.link).toBeNull();
    expect(await queuedIntents()).toEqual([{ type: "unlinkContact", contactId: "b" }]);
  });

  it("keeps a group of three as a group of two", async () => {
    await linkContacts("link-1", "a", "b");
    await linkContacts("link-2", "b", "c");

    await unlinkContact("c");

    const links = await readContactLinks();
    expect([...(links[0]?.contactIds ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("is a no-op for a Contact in no link", async () => {
    await unlinkContact("a");
    expect(await readContactLinks()).toEqual([]);
  });
});

describe("setLinkedContactFront (#222)", () => {
  beforeEach(async () => {
    await localCache().contacts.bulkPut([makeContact("a", LOCAL.id), makeContact("b", GOOGLE.id)]);
    await linkContacts("link-1", "a", "b");
  });

  it("fronts the record the User picked, over the Default Address Book's", async () => {
    await setLinkedContactFront("link-1", "b");
    expect((await readLinkedContactGroup("a"))?.front.id).toBe("b");
  });

  it("goes back to deriving the front when the pick is cleared", async () => {
    await setLinkedContactFront("link-1", "b");
    await setLinkedContactFront("link-1", null);
    expect((await readLinkedContactGroup("a"))?.front.id).toBe("a");
  });

  it("ignores a record that isn't a member", async () => {
    await setLinkedContactFront("link-1", "not-a-member");
    const [link] = await readContactLinks();
    expect(link?.frontContactId).toBeNull();
  });
});

describe("duplicateCandidatesInScope (#222)", () => {
  const a = makeContact("a", "book-local", { emails: [email("ada@example.com")] });
  const b = makeContact("b", "book-google", { emails: [email("ADA@example.com")] });
  const c = makeContact("c", "book-local", { emails: [email("grace@example.com")] });

  it("suggests a pair sharing an address across Address Books", () => {
    const map = duplicateCandidatesInScope([a, b, c], []);
    expect(map.get("a")).toEqual(["b"]);
    expect(map.has("c")).toBe(false);
  });

  it("drops a pair the User has already answered by linking it", () => {
    const link: ContactLink = {
      id: "link-1",
      contactIds: ["a", "b"],
      frontContactId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(duplicateCandidatesInScope([a, b, c], [link]).size).toBe(0);
  });
});
