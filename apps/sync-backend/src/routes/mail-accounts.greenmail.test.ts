import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import {
  deriveCredentialKey,
  unsealPasswordCredential,
} from "../mail-accounts/credential-crypto.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * The real verify + save path against the GreenMail dev server
 * (compose.dev.yaml, docs/dev-setup.md), not a stub — the acceptance box
 * poc-spec.md's Mail Accounts section names explicitly. No `verify`/
 * `discover` override is passed to `buildApp` here: this test exercises the
 * actual `imapflow`/`nodemailer` code path end to end.
 */
const PUBLIC_URL = "http://localhost:3000";
const IMAP_HOST = process.env.IMAP_TEST_HOST ?? "localhost";
const IMAP_PORT = Number(process.env.IMAP_TEST_PORT ?? 3143);
const SMTP_PORT = Number(process.env.SMTP_TEST_PORT ?? 3025);

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

async function claimOwner(): Promise<string> {
  let captured = "";
  const originalInfo = app.log.info.bind(app.log);
  app.log.info = ((payload: unknown, ...rest: unknown[]) => {
    if (typeof payload === "object" && payload && "claimToken" in payload) {
      captured = String((payload as { claimToken: string }).claimToken);
    }
    return originalInfo(payload as never, ...(rest as []));
  }) as typeof app.log.info;
  await ensureClaimToken(db, app.log, PUBLIC_URL);
  app.log.info = originalInfo;

  const response = await app.inject({
    method: "POST",
    url: "/auth/claim",
    payload: { token: captured, username: "vic", password: "a-long-enough-password" },
  });
  return extractCookie(response.headers["set-cookie"]);
}

beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  closeDb = () => created.sql.end();
  await resetTestDb(db);
  app = buildApp({ db, publicUrl: PUBLIC_URL, mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });
});

afterAll(async () => {
  await closeDb?.();
});

describe("Mail Account add flow against GreenMail", () => {
  it("verifies real IMAP+SMTP, saves, and never exposes the credential", async () => {
    const cookie = await claimOwner();
    const session = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    const userId: string = session.json().user.id;

    // GreenMail's dynamic accounts (`greenmail.users.login=email`,
    // `greenmail.auth.disabled`) accept any address/password (`.test` is
    // IANA's reserved non-resolving TLD, since `z.email()` requires one).
    const emailAddress = `vic-${Date.now()}@mail.test`;
    const password = "whatever-password-works-here";

    const create = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: {
        emailAddress,
        imap: { host: IMAP_HOST, port: IMAP_PORT, security: "none" },
        smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none" },
        username: emailAddress,
        password,
      },
    });

    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.mailAccount).toMatchObject({ emailAddress, status: "active" });
    expect(JSON.stringify(body)).not.toContain(password);

    // The credential really is sealed at rest, under this Mail Account's id
    // as associated data (ADR-0003) — not just absent from the API response.
    const stored = await getMailAccountForUser(db, userId, body.mailAccount.id);
    if (!stored) {
      throw new Error("saved Mail Account row not found");
    }
    expect(JSON.stringify(stored.credential)).not.toContain(password);
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    expect(unsealPasswordCredential(stored.credential, stored.id, key)).toBe(password);
  });

  it("rejects a connection to a port nothing is listening on as a connection failure", async () => {
    const cookie = await claimOwner();
    const emailAddress = `vic-${Date.now()}@mail.test`;

    const create = await app.inject({
      method: "POST",
      url: "/mail-accounts",
      headers: { cookie },
      payload: {
        emailAddress,
        imap: { host: IMAP_HOST, port: 1, security: "none" },
        smtp: { host: IMAP_HOST, port: SMTP_PORT, security: "none" },
        username: emailAddress,
        password: "irrelevant",
      },
    });

    expect(create.statusCode).toBe(502);
    expect(create.json()).toMatchObject({ error: "connection_failed" });
  });
});
