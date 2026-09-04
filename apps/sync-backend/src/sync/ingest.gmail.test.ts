import { randomUUID } from "node:crypto";
import type { ComposeDocument } from "@mail/shared";
import { eq } from "drizzle-orm";
import type { FetchMessageObject } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { compositions, correspondents, folders, messages } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { recordCorrespondentActivity } from "./correspondents.js";
import type { FolderRow } from "./folders.js";
import { storeMessage } from "./ingest.js";

/**
 * `storeMessage`'s Gmail-specific behavior (#122, ADR-0020) against a real
 * test database but a hand-built `FetchMessageObject` — no ImapFlow client
 * is needed, because `storeMessage` never touches one. The GreenMail suite
 * (`sync-plan.greenmail.test.ts`, `ingest.greenmail.test.ts`) proves the
 * generic path these tests don't touch is unaffected; the live Gmail suite
 * (`sync-plan.live-gmail.test.ts`) proves a real server's All Mail answers
 * `X-GM-LABELS` the way these fixtures assume.
 */
let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

async function seedFolder(role: FolderRow["role"], path: string): Promise<FolderRow> {
  const [row] = await db
    .insert(folders)
    .values({
      id: randomUUID(),
      mailAccountId: account.id,
      path,
      name: path,
      role,
      uidValidity: 1,
    })
    .returning();
  if (!row) throw new Error("failed to seed folder");
  return row;
}

function fetchedMessage(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    uid: 42,
    flags: new Set<string>(),
    envelope: { subject: "Hi", messageId: `<${randomUUID()}@example.test>` },
    internalDate: new Date("2025-06-02T09:00:00Z"),
    ...overrides,
  } as FetchMessageObject;
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db, { serverKind: "gmail" });
});

afterAll(async () => {
  await closeDb?.();
});

describe("storeMessage — Gmail Labels and Draft skip (#122)", () => {
  it("stores a message's Gmail Labels when ingested from All Mail", async () => {
    const allMail = await seedFolder("all", "[Gmail]/All Mail");
    const fetched = fetchedMessage({ labels: new Set(["\\Inbox", "\\Important"]) });

    const stored = await storeMessage(db, allMail, 1, fetched, "", "gmail");
    expect(stored).not.toBeNull();

    const [row] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, stored?.id ?? ""));
    expect(row?.gmailLabels?.sort()).toEqual(["\\Important", "\\Inbox"]);
  });

  it("stores null Gmail Labels when the folder isn't All Mail", async () => {
    const trash = await seedFolder("trash", "[Gmail]/Trash");
    const stored = await storeMessage(db, trash, 1, fetchedMessage(), "", "gmail");
    expect(stored).not.toBeNull();

    const [row] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, stored?.id ?? ""));
    expect(row?.gmailLabels).toBeNull();
  });

  it("skips a \\Draft message on Gmail's All Mail entirely", async () => {
    const allMail = await seedFolder("all", "[Gmail]/All Mail");
    const fetched = fetchedMessage({ flags: new Set(["\\Draft"]) });

    const stored = await storeMessage(db, allMail, 1, fetched, "", "gmail");
    expect(stored).toBeNull();

    const rows = await db.select().from(messages).where(eq(messages.folderId, allMail.id));
    expect(rows).toHaveLength(0);
  });

  it("does not skip a \\Draft message on a generic account's INBOX", async () => {
    const generic = await createTestMailAccount(db, { serverKind: "generic" });
    const [inbox] = await db
      .insert(folders)
      .values({
        id: randomUUID(),
        mailAccountId: generic.id,
        path: "INBOX",
        name: "INBOX",
        role: "inbox",
        uidValidity: 1,
      })
      .returning();
    if (!inbox) throw new Error("failed to seed folder");

    const fetched = fetchedMessage({ flags: new Set(["\\Draft"]) });
    const stored = await storeMessage(db, inbox, 1, fetched, "", "generic");
    expect(stored).not.toBeNull();
  });

  it("does not skip a \\Draft message on Gmail's own Drafts Folder", async () => {
    const drafts = await seedFolder("drafts", "[Gmail]/Drafts");
    const fetched = fetchedMessage({ flags: new Set(["\\Draft"]) });

    const stored = await storeMessage(db, drafts, 1, fetched, "", "gmail");
    expect(stored).not.toBeNull();
  });

  it("does not double-count Correspondent activity for a \\Sent All Mail message already recorded at send time (#123)", async () => {
    const messageId = `<${randomUUID()}@mail.test>`;
    const doc: ComposeDocument = { type: "doc", content: [{ type: "paragraph" }] };
    await db.insert(compositions).values({
      id: randomUUID(),
      mailAccountId: account.id,
      status: "sent",
      subject: "Hi",
      document: doc,
      messageId: messageId.replace(/^<|>$/g, ""),
      version: 1,
    });
    // The composition's send already recorded this recipient's activity
    // (`compose/send-sweeper.ts#sweepOne`) — the ordinary poll ingesting the
    // \Sent All Mail copy back must not count it a second time.
    await recordCorrespondentActivity(db, account.id, [
      { address: "bo@example.com", name: "Bo", direction: "sent", at: new Date() },
    ]);

    const allMail = await seedFolder("all", "[Gmail]/All Mail");
    const fetched = fetchedMessage({
      labels: new Set(["\\Sent"]),
      envelope: {
        subject: "Hi",
        messageId,
        to: [{ name: "Bo", address: "bo@example.com" }],
      },
    });

    const stored = await storeMessage(db, allMail, 1, fetched, "me@example.com", "gmail");
    expect(stored).not.toBeNull();

    const rows = await db
      .select()
      .from(correspondents)
      .where(eq(correspondents.mailAccountId, account.id));
    // Exactly the one row `recordCorrespondentActivity` above created, with
    // its sentCount untouched by the re-ingest.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sentCount: 1 });
  });
});
