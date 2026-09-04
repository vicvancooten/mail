import { gmailLabelId } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { gmailLabels, syncTombstones } from "../db/schema.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import {
  isBrowsableGmailLabel,
  isBrowsableGmailLabelName,
  type ListedMailbox,
  persistGmailLabels,
} from "./gmail-labels.js";

const KIDS_LABEL: ListedMailbox = {
  role: null,
  name: "Kids",
  path: "Family/Kids",
  selectable: true,
};

describe("isBrowsableGmailLabel", () => {
  it("accepts an ordinary user Label with no recognized special-use flag", () => {
    expect(isBrowsableGmailLabel(KIDS_LABEL)).toBe(true);
  });

  it("rejects the four Folders Gmail actually syncs (All Mail, Spam, Trash, Drafts)", () => {
    for (const role of ["all", "junk", "trash", "drafts"] as const) {
      expect(isBrowsableGmailLabel({ role, name: "whatever", path: "x", selectable: true })).toBe(
        false,
      );
    }
  });

  it("rejects Inbox, Sent and Starred by their recognized special-use role", () => {
    for (const role of ["inbox", "sent", "flagged"] as const) {
      expect(isBrowsableGmailLabel({ role, name: "whatever", path: "x", selectable: true })).toBe(
        false,
      );
    }
  });

  it("rejects Important and Chats by name, even with no recognized role (#91 story 40)", () => {
    expect(
      isBrowsableGmailLabel({
        role: null,
        name: "Important",
        path: "[Gmail]/Important",
        selectable: true,
      }),
    ).toBe(false);
    expect(
      isBrowsableGmailLabel({ role: null, name: "Chats", path: "[Gmail]/Chats", selectable: true }),
    ).toBe(false);
  });

  it("rejects a Category-looking name defensively", () => {
    expect(
      isBrowsableGmailLabel({
        role: null,
        name: "Categories",
        path: "Categories",
        selectable: true,
      }),
    ).toBe(false);
  });

  it("rejects an unselectable (\\Noselect) container", () => {
    expect(isBrowsableGmailLabel({ ...KIDS_LABEL, selectable: false })).toBe(false);
  });
});

describe("isBrowsableGmailLabelName", () => {
  it("accepts an ordinary user Gmail Label as reported by X-GM-LABELS", () => {
    expect(isBrowsableGmailLabelName("Family/Kids")).toBe(true);
  });

  it("rejects every system pseudo-label", () => {
    for (const name of [
      "\\Inbox",
      "\\Sent",
      "\\Draft",
      "\\Starred",
      "\\Important",
      "\\Trash",
      "\\Spam",
      "\\Chat",
    ]) {
      expect(isBrowsableGmailLabelName(name)).toBe(false);
    }
  });
});

let db: Db;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("persistGmailLabels", () => {
  it("stores a Gmail account's browsable Labels, deterministic-id keyed", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    await persistGmailLabels(db, account.id, "gmail", [KIDS_LABEL]);

    const rows = await db
      .select()
      .from(gmailLabels)
      .where(eq(gmailLabels.mailAccountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: gmailLabelId(account.id, "Family/Kids"),
      name: "Kids",
      path: "Family/Kids",
    });
  });

  it("never persists a system label alongside a real user Label", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    await persistGmailLabels(db, account.id, "gmail", [
      KIDS_LABEL,
      { role: "inbox", name: "Inbox", path: "INBOX", selectable: true },
      { role: "all", name: "All Mail", path: "[Gmail]/All Mail", selectable: true },
    ]);

    const rows = await db
      .select()
      .from(gmailLabels)
      .where(eq(gmailLabels.mailAccountId, account.id));
    expect(rows.map((row) => row.path)).toEqual(["Family/Kids"]);
  });

  it("is a no-op on a generic account, and clears any rows if a Mail Account's kind is ever re-detected away from gmail", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    await persistGmailLabels(db, account.id, "gmail", [KIDS_LABEL]);
    await persistGmailLabels(db, account.id, "generic", [KIDS_LABEL]);

    const rows = await db
      .select()
      .from(gmailLabels)
      .where(eq(gmailLabels.mailAccountId, account.id));
    expect(rows).toEqual([]);
  });

  it("reflects a rename as a tombstone of the old path plus a create of the new one", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    await persistGmailLabels(db, account.id, "gmail", [KIDS_LABEL]);
    const oldId = gmailLabelId(account.id, "Family/Kids");

    await persistGmailLabels(db, account.id, "gmail", [
      { ...KIDS_LABEL, name: "Toddlers", path: "Family/Toddlers" },
    ]);

    const rows = await db
      .select()
      .from(gmailLabels)
      .where(eq(gmailLabels.mailAccountId, account.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Toddlers", path: "Family/Toddlers" });

    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.mailAccountId, account.id));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ collection: "GmailLabel", entityId: oldId });
  });

  it("deletes and tombstones a Label removed in Gmail", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    await persistGmailLabels(db, account.id, "gmail", [KIDS_LABEL]);
    const id = gmailLabelId(account.id, "Family/Kids");

    await persistGmailLabels(db, account.id, "gmail", []);

    const rows = await db
      .select()
      .from(gmailLabels)
      .where(eq(gmailLabels.mailAccountId, account.id));
    expect(rows).toEqual([]);
    const tombstones = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.mailAccountId, account.id));
    expect(tombstones.map((row) => row.entityId)).toEqual([id]);
  });

  it("touches nothing on a re-poll that finds the same Labels unchanged", async () => {
    const account = await createTestMailAccount(db, { serverKind: "gmail" });
    await persistGmailLabels(db, account.id, "gmail", [KIDS_LABEL]);
    const [before] = await db
      .select()
      .from(gmailLabels)
      .where(eq(gmailLabels.mailAccountId, account.id));

    await persistGmailLabels(db, account.id, "gmail", [KIDS_LABEL]);

    const [after] = await db
      .select()
      .from(gmailLabels)
      .where(eq(gmailLabels.mailAccountId, account.id));
    expect(after?.syncRev).toEqual(before?.syncRev);
  });
});
