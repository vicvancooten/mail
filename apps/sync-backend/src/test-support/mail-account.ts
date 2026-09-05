import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { mailAccounts, users } from "../db/schema.js";
import {
  deriveCredentialKey,
  type MailAccountCredential,
  sealOAuthCredential,
  sealPasswordCredential,
} from "../mail-accounts/credential-crypto.js";
import type { MailAccountServerKind } from "../mail-accounts/server-kind.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { TEST_MAIL_CREDENTIAL_KEY } from "./db.js";

export interface TestMailAccountInput {
  emailAddress?: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  smtpPort?: number;
  /** Adds this Mail Account to an existing User instead of creating a new one — an Account Scope (#68) test's second, same-User account. */
  userId?: string;
  /**
   * Seeds an `oauth` credential (the Grant) instead of `password` — #114:
   * no sign-in flow exists yet, so a test inserting one directly is the only
   * way an oauth-variant Mail Account row comes to exist. Ignored when
   * `password` is also set; the two are mutually exclusive credential kinds.
   */
  oauth?: { accessToken: string; provider?: "google" | "microsoft" };
  /**
   * Stamps `serverKind` directly (#122) — for a test that wants a
   * Gmail-shaped row (the sync plan, the resident loop's watched Folder)
   * without a real `X-GM-EXT-1`-advertising server to detect it from
   * (`mail-accounts/server-kind.ts`). Left undetected (`null`) by default to
   * model a pre-#121 row — or a test that explicitly wants an undetected
   * account.
   */
  serverKind?: MailAccountServerKind;
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

  const userId = input.userId ?? randomUUID();
  if (!input.userId) {
    await db.insert(users).values({
      id: userId,
      username: `user-${userId.slice(0, 8)}`,
      passwordHash: "not-a-real-hash",
      role: "owner",
    });
  }

  const id = randomUUID();
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  const credential: MailAccountCredential = input.oauth
    ? sealOAuthCredential(
        {
          provider: input.oauth.provider ?? "google",
          accessToken: input.oauth.accessToken,
          refreshToken: "unused-in-this-ticket-refresh-token",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          scope: ["https://mail.google.com/"],
        },
        id,
        key,
      )
    : sealPasswordCredential(password, id, key);
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
      credential,
      serverKind: input.serverKind,
    })
    .returning();

  if (!row) throw new Error("test Mail Account insert returned no row");
  return row;
}
