import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb, resetTestDb } from "./db.js";
import { createTestMailAccount } from "./mail-account.js";

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

describe("createTestMailAccount", () => {
  it("seeds Microsoft oauth credentials with Microsoft scopes", async () => {
    const account = await createTestMailAccount(db, {
      oauth: { provider: "microsoft", accessToken: "access-token" },
    });

    expect(account.credential.kind).toBe("oauth");
    if (account.credential.kind !== "oauth") {
      throw new Error("expected oauth credential");
    }
    expect(account.credential.provider).toBe("microsoft");
    expect(account.credential.scope).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(account.credential.scope).toContain("https://outlook.office.com/SMTP.Send");
    expect(account.credential.scope).not.toContain("https://mail.google.com/");
  });
});
