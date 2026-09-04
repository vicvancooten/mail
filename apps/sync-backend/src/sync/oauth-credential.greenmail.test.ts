import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { verifyMailAccountCredentials } from "../mail-accounts/verify.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";
import { buildTestMessage } from "../test-support/mime.js";
import { syncMailAccount } from "./sync-account.js";

/**
 * #114's acceptance box: a Mail Account whose credential is the `oauth`
 * variant connects, verifies, and syncs over XOAUTH2 exactly like a password
 * account — against the real GreenMail dev server (compose.dev.yaml), which
 * advertises `AUTH=XOAUTH2` (docs/dev-setup.md) and, with
 * `-Dgreenmail.auth.disabled`, accepts any bearer token the same way it
 * accepts any password.
 */
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);
const SMTP_PORT = Number(process.env.SMTP_TEST_PORT ?? 3025);

let db: Db;
let closeDb: () => Promise<void>;

/** A fresh mailbox per run: GreenMail creates an account on first login. */
async function seedInbox(emailAddress: string): Promise<void> {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: emailAddress, pass: "anything" },
    logger: false,
  });
  await client.connect();
  try {
    await client.append(
      "INBOX",
      buildTestMessage({
        from: "Alice Anderson <alice@example.test>",
        to: emailAddress,
        subject: "Hello over XOAUTH2",
        date: new Date(Date.UTC(2025, 2, 1, 9, 0, 0)),
        messageId: "xoauth2-a@example.test",
        text: "Reached over an access token, not a password.",
      }),
      [],
      new Date(Date.UTC(2025, 2, 1, 9, 0, 0)),
    );
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
});

afterAll(async () => {
  await closeDb?.();
});

describe("an oauth-variant Mail Account against GreenMail", () => {
  it("verifies and completes an initial sync over XOAUTH2", async () => {
    const emailAddress = `oauth-${Date.now()}@mail.test`;
    await seedInbox(emailAddress);

    const account = await createTestMailAccount(db, {
      emailAddress,
      imapPort: IMAP_PORT,
      smtpPort: SMTP_PORT,
      oauth: { accessToken: "the-grant-access-token" },
    });

    const verifyResult = await verifyMailAccountCredentials({
      imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none" },
      smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none" },
      username: emailAddress,
      credential: { kind: "oauth", accessToken: "the-grant-access-token" },
    });
    // GreenMail doesn't advertise Gmail's `X-GM-EXT-1` capability (#121, ADR-0020).
    expect(verifyResult).toEqual({ ok: true, serverKind: "generic" });

    const result = await syncMailAccount(db, account, {
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });
    expect(result.status).toBe("synced");

    const rows = await db.select().from(messages).where(eq(messages.mailAccountId, account.id));
    expect(rows.map((row) => row.subject)).toContain("Hello over XOAUTH2");
  });
});
