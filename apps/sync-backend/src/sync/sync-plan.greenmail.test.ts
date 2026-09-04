import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { discoverFolders, persistFolders } from "./folders.js";
import { connectMailAccount } from "./imap-connection.js";
import { listSyncPlanFolders, resolveSyncPlan, resolveWatchFolder } from "./sync-plan.js";

/**
 * Proves the non-Gmail path is untouched (#122): against a real GreenMail
 * server (no `X-GM-EXT-1`, so `account.serverKind` lands `"generic"` the way
 * every account did before this ticket), the sync plan is every selectable
 * Folder GreenMail's own default INBOX/Trash listing has, and the watched
 * Folder is INBOX — exactly `sync/live-session.ts`'s pre-#122 behavior.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);

let db: Db;
let closeDb: () => Promise<void>;
let account: MailAccountRow;

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  account = await createTestMailAccount(db, { imapHost: IMAP_HOST, imapPort: IMAP_PORT });
});

afterAll(async () => {
  await closeDb?.();
});

describe("sync plan against GreenMail", () => {
  it("detects a generic server kind and plans every selectable folder", async () => {
    const client = await connectMailAccount(db, account, {
      credentialKey: deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY),
    });
    try {
      expect(client.capabilities.has("X-GM-EXT-1")).toBe(false);
      const live = await persistFolders(db, account.id, await discoverFolders(client));
      const selectable = live.filter((folder) => folder.selectable);

      const plan = resolveSyncPlan("generic", live);
      expect(plan.map((folder) => folder.id).sort()).toEqual(
        selectable.map((folder) => folder.id).sort(),
      );

      const watch = resolveWatchFolder("generic", plan);
      expect(watch?.role).toBe("inbox");

      const planFromDb = await listSyncPlanFolders(db, account.id, "generic");
      expect(planFromDb.map((folder) => folder.id).sort()).toEqual(
        selectable.map((folder) => folder.id).sort(),
      );
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  });
});
