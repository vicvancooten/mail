import { randomUUID } from "node:crypto";
import { EMPTY_CONTACT_FIELDS } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ensureLocalAddressBookId } from "../address-books/store.js";
import type { Db } from "../db/client.js";
import { contacts, repairs } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { runRepairs } from "../repairs/runner.js";
import { createTestDb, resetTestDb } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { repairDemotedAddresses } from "./repair-demoted-addresses.js";
import { insertContact } from "./store.js";

/**
 * #284's own store seam, against a real Postgres — `contact-purge.test.ts`'s
 * own template. Runs the repair through `runRepairs` (never
 * `repairDemotedAddresses.run` directly) so its own completion recording is
 * covered the same way its promotion logic is.
 */
let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db);
});

afterAll(async () => {
  await closeDb?.();
});

async function seedContact(
  customFields: (typeof EMPTY_CONTACT_FIELDS)["customFields"],
): Promise<string> {
  const addressBookId = await ensureLocalAddressBookId(db, account.userId);
  const contactId = randomUUID();
  await insertContact(db, account.userId, addressBookId, contactId, {
    ...EMPTY_CONTACT_FIELDS,
    customFields,
  });
  return contactId;
}

async function contactRow(contactId: string) {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!row) throw new Error("expected contact row");
  return row;
}

describe("repairDemotedAddresses", () => {
  it("promotes a Custom Field holding a valid email into emails, keeping its label, and drops the Custom Field", async () => {
    const contactId = await seedContact([
      { id: "cf-1", label: "Boat", type: "text", value: "skipper@example.com" },
    ]);

    await runRepairs(db, [repairDemotedAddresses]);

    const row = await contactRow(contactId);
    expect(row.emails).toEqual([
      { id: "cf-1", type: "Boat", value: "skipper@example.com", primary: false },
    ]);
    expect(row.customFields).toEqual([]);
  });

  it("defaults a blank label to home, the same default splitTypedContactFields applies", async () => {
    const contactId = await seedContact([
      { id: "cf-1", label: "", type: "text", value: "blank-label@example.com" },
    ]);

    await runRepairs(db, [repairDemotedAddresses]);

    const row = await contactRow(contactId);
    expect(row.emails).toEqual([
      { id: "cf-1", type: "home", value: "blank-label@example.com", primary: false },
    ]);
  });

  it("leaves a Custom Field whose value isn't a valid email untouched", async () => {
    const contactId = await seedContact([
      { id: "cf-1", label: "Boat", type: "text", value: "not an email" },
    ]);

    await runRepairs(db, [repairDemotedAddresses]);

    const row = await contactRow(contactId);
    expect(row.emails).toEqual([]);
    expect(row.customFields).toEqual([
      { id: "cf-1", label: "Boat", type: "text", value: "not an email" },
    ]);
  });

  it("keeps an existing email and appends the promoted one alongside it", async () => {
    const addressBookId = await ensureLocalAddressBookId(db, account.userId);
    const contactId = randomUUID();
    await insertContact(db, account.userId, addressBookId, contactId, {
      ...EMPTY_CONTACT_FIELDS,
      emails: [{ id: "e-1", type: "work", value: "already@example.com", primary: true }],
      customFields: [{ id: "cf-1", label: "Boat", type: "text", value: "skipper@example.com" }],
    });

    await runRepairs(db, [repairDemotedAddresses]);

    const row = await contactRow(contactId);
    expect(row.emails).toEqual([
      { id: "e-1", type: "work", value: "already@example.com", primary: true },
      { id: "cf-1", type: "Boat", value: "skipper@example.com", primary: false },
    ]);
  });

  it("records completion and changes nothing on a second run", async () => {
    const contactId = await seedContact([
      { id: "cf-1", label: "Boat", type: "text", value: "skipper@example.com" },
    ]);

    await runRepairs(db, [repairDemotedAddresses]);
    const afterFirstRun = await contactRow(contactId);

    // A second Custom Field with a valid email, added after the repair ran
    // once, models an ordinary post-repair Contact edit — it must stay
    // exactly as the User entered it, since the repair records that it ran
    // and never runs again on this instance.
    await db
      .update(contacts)
      .set({
        customFields: [
          ...afterFirstRun.customFields,
          { id: "cf-2", label: "Cabin", type: "text", value: "cabin@example.com" },
        ],
      })
      .where(eq(contacts.id, contactId));

    await runRepairs(db, [repairDemotedAddresses]);

    const row = await contactRow(contactId);
    expect(row.emails).toEqual(afterFirstRun.emails);
    expect(row.customFields).toEqual([
      { id: "cf-2", label: "Cabin", type: "text", value: "cabin@example.com" },
    ]);

    const [record] = await db
      .select()
      .from(repairs)
      .where(eq(repairs.id, "repair-demoted-addresses"));
    expect(record).toBeDefined();
  });

  it("leaves a Contact with no Custom Fields untouched", async () => {
    const contactId = await seedContact([]);

    await runRepairs(db, [repairDemotedAddresses]);

    const row = await contactRow(contactId);
    expect(row.emails).toEqual([]);
    expect(row.customFields).toEqual([]);
  });
});
