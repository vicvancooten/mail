import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { messages } from "../db/schema.js";
import { deriveCredentialKey } from "../mail-accounts/credential-crypto.js";
import { getMailAccountForUser } from "../mail-accounts/store.js";
import { discoverFolders, persistFolders } from "../sync/folders.js";
import { connectMailAccount } from "../sync/imap-connection.js";
import { ingestFolder } from "../sync/ingest.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { buildTestMessage } from "../test-support/mime.js";

/**
 * The reading-pane routes (#41) end to end against GreenMail: a hostile
 * HTML body that has never been through the background sweep (fetch-through
 * on demand, `resolvePendingBodies`), a `cid:`-referenced inline image and a
 * real attachment both fetched through live IMAP downloads, never cached.
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

/** Creates a Mail Account through the real route, verified live against GreenMail. */
async function createOwnedMailAccount(
  cookie: string,
  emailAddress: string,
): Promise<{ id: string; password: string }> {
  const password = "whatever-password-works-here";
  const response = await app.inject({
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
  expect(response.statusCode).toBe(201);
  return { id: (response.json().mailAccount as { id: string }).id, password };
}

async function appendToInbox(emailAddress: string, mime: string, date: Date): Promise<void> {
  const seeder = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: emailAddress, pass: "anything" },
    logger: false,
  });
  await seeder.connect();
  try {
    await seeder.append("INBOX", mime, [], date);
  } finally {
    await seeder.logout().catch(() => undefined);
    seeder.close();
  }
}

/** Headers-only ingest — the body stays lazy, exactly what the route's own fetch-through has to cover. */
async function ingestHeaders(userId: string, mailAccountId: string): Promise<void> {
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  const account = await getMailAccountForUser(db, userId, mailAccountId);
  if (!account) throw new Error("mail account not found for headers-only ingest");
  const client = await connectMailAccount(db, account, { credentialKey: key });
  try {
    const live = await persistFolders(db, mailAccountId, await discoverFolders(client));
    const inbox = live.find((folder) => folder.role === "inbox");
    if (!inbox) throw new Error("INBOX was not discovered");
    await ingestFolder(db, client, inbox);
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
}

async function sessionUserId(cookie: string): Promise<string> {
  const response = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
  return (response.json().user as { id: string }).id;
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

describe("reading-pane routes against GreenMail", () => {
  it("fetch-throughs a body the sweep never reached, sanitized and proxy-rewritten", async () => {
    const cookie = await claimOwner();
    const emailAddress = `msg-fetch-through-${Date.now()}@mail.test`;
    const { id: mailAccountId } = await createOwnedMailAccount(cookie, emailAddress);
    const userId = await sessionUserId(cookie);

    const date = new Date();
    await appendToInbox(
      emailAddress,
      buildTestMessage({
        from: "Sender <sender@example.test>",
        to: emailAddress,
        subject: "Hostile",
        date,
        messageId: `hostile-${Date.now()}@example.test`,
        html:
          `<p>hi</p><script>steal(document.cookie)</script>` +
          `<img src="https://tracker.example/pixel.gif" onerror="alert(1)">`,
      }),
      date,
    );
    await ingestHeaders(userId, mailAccountId);

    const [row] = await db.select().from(messages).where(eq(messages.mailAccountId, mailAccountId));
    expect(row).toBeDefined();
    expect(row?.bodyFetchedAt).toBeNull(); // headers-only ingest: still lazy

    const response = await app.inject({
      method: "GET",
      url: `/threads/${row?.threadId}/messages`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { messages: Array<{ id: string; bodyHtml: string | null }> };
    expect(body.messages).toHaveLength(1);
    const html = body.messages[0]?.bodyHtml ?? "";
    expect(html).toContain("<p>hi</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("https://tracker.example");
    expect(html).toContain(`/messages/${row?.id}/image-proxy?url=`);

    // The fetch-through wrote the body back — the sweep finds nothing left
    // to do for this message on its next pass.
    const [after] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, row?.id ?? ""));
    expect(after?.bodyFetchedAt).not.toBeNull();
  });

  it("fetch-throughs a cid:-referenced inline image and a real attachment's bytes", async () => {
    const cookie = await claimOwner();
    const emailAddress = `msg-attachments-${Date.now()}@mail.test`;
    const { id: mailAccountId } = await createOwnedMailAccount(cookie, emailAddress);
    const userId = await sessionUserId(cookie);

    const date = new Date();
    const inlineBytes = "logo-bytes";
    const attachmentBytes = "attachment-bytes-here";
    await appendToInbox(
      emailAddress,
      buildTestMessage({
        from: "Sender <sender@example.test>",
        to: emailAddress,
        subject: "With attachments",
        date,
        messageId: `attach-${Date.now()}@example.test`,
        html: `<p>see <img src="cid:logo@example"></p>`,
        attachments: [
          { contentType: "image/png", contentId: "logo@example", content: inlineBytes },
          { contentType: "text/plain", filename: "notes.txt", content: attachmentBytes },
        ],
      }),
      date,
    );
    await ingestHeaders(userId, mailAccountId);

    const [row] = await db.select().from(messages).where(eq(messages.mailAccountId, mailAccountId));
    expect(row).toBeDefined();

    const list = await app.inject({
      method: "GET",
      url: `/threads/${row?.threadId}/messages`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json() as {
      messages: Array<{
        id: string;
        bodyHtml: string | null;
        attachments: Array<{ part: string; filename: string | null; contentId: string | null }>;
      }>;
    };
    const message = listed.messages[0];
    expect(message?.bodyHtml).toContain('src="cid:logo@example"');
    // Both attachments travel on the wire — the cid:-only inline part is
    // still here so the Client can resolve `cid:logo@example` against it.
    expect(message?.attachments).toHaveLength(2);
    const realAttachment = message?.attachments.find((a) => a.filename === "notes.txt");
    const inlinePart = message?.attachments.find((a) => a.contentId === "logo@example");
    expect(realAttachment).toBeDefined();
    expect(inlinePart).toBeDefined();

    const download = await app.inject({
      method: "GET",
      url: `/messages/${message?.id}/attachments/${realAttachment?.part}`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe(attachmentBytes);
    expect(download.headers["content-type"]).toBe("text/plain");

    const inlineDownload = await app.inject({
      method: "GET",
      url: `/messages/${message?.id}/attachments/${inlinePart?.part}`,
      headers: { cookie },
    });
    expect(inlineDownload.statusCode).toBe(200);
    expect(inlineDownload.body).toBe(inlineBytes);
  });
});
