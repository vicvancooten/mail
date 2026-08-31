import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { mailAccounts, users } from "../db/schema.js";
import { deriveCredentialKey, sealPasswordCredential } from "../mail-accounts/credential-crypto.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { TEST_MAIL_CREDENTIAL_KEY } from "./db.js";

export interface TestMailAccountInput {
  emailAddress?: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  smtpPort?: number;
}

/**
 * Inserts a User and a Mail Account straight into the database, sealed the
 * way `/mail-accounts` would seal it. Sync tests need a live account row but
 * not the HTTP flow that creates one — that path is #33's and has its own
 * coverage.
 */
export async function createTestMailAccount(
  db: Db,
  input: TestMailAccountInput = {},
): Promise<MailAccountRow> {
  const emailAddress = input.emailAddress ?? `sync-${randomUUID()}@mail.test`;
  const password = input.password ?? "greenmail-accepts-anything";
  const host = input.imapHost ?? "localhost";

  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId.slice(0, 8)}`,
    passwordHash: "not-a-real-hash",
    role: "owner",
  });

  const id = randomUUID();
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  const [row] = await db
    .insert(mailAccounts)
    .values({
      id,
      userId,
      emailAddress,
      imapHost: host,
      imapPort: input.imapPort ?? 3143,
      imapSecurity: "none",
      smtpHost: host,
      smtpPort: input.smtpPort ?? 3025,
      smtpSecurity: "none",
      username: emailAddress,
      credential: sealPasswordCredential(password, id, key),
    })
    .returning();

  if (!row) throw new Error("test Mail Account insert returned no row");
  return row;
}
