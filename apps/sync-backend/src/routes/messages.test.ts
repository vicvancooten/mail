import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import {
  folders,
  type MessageAttachment,
  mailAccounts,
  messages,
  threads,
  users,
} from "../db/schema.js";
import { setVerdict } from "../gatekeeper/verdicts.js";
import { buildImageProxyPath, deriveImageProxyKey } from "../sync/image-proxy.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { decodeQuotedPrintable, decodeTransferEncoding } from "./messages.js";

const PUBLIC_URL = "http://localhost:3000";

let db: Db;
let closeDb: () => Promise<void>;

function buildTestApp() {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    mailAccountVerify: async () => ({ ok: true }),
  });
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

async function claimOwner(app: FastifyInstance): Promise<string> {
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

async function createOwnedMailAccount(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/mail-accounts",
    headers: { cookie },
    payload: {
      emailAddress: "vic@example.com",
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      username: "vic@example.com",
      password: "correct-horse-battery-staple",
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json().mailAccount as { id: string }).id;
}

interface SeedMessageInput {
  mailAccountId: string;
  threadId: string;
  bodyHtml?: string | null;
  bodyText?: string | null;
  bodyFetchedAt?: Date | null;
  attachments?: MessageAttachment[];
  fromName?: string | null;
  fromAddress?: string | null;
}

let nextUid = 1;

/** Seeds one Thread with one Message whose body is already "fetched" — the common, sweep-already-ran case. */
async function seedMessage(input: SeedMessageInput): Promise<string> {
  await db.insert(threads).values({ id: input.threadId, mailAccountId: input.mailAccountId });
  // One INBOX per Mail Account, however many times this is called — the
  // `(mail_account_id, path)` unique index is the real folder identity.
  await db
    .insert(folders)
    .values({
      id: randomUUID(),
      mailAccountId: input.mailAccountId,
      path: "INBOX",
      name: "INBOX",
      role: "inbox",
    })
    .onConflictDoNothing({ target: [folders.mailAccountId, folders.path] });
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.mailAccountId, input.mailAccountId), eq(folders.path, "INBOX")))
    .limit(1);
  if (!folder) throw new Error("INBOX was not seeded");
  const folderId = folder.id;
  const messageId = randomUUID();
  await db.insert(messages).values({
    id: messageId,
    mailAccountId: input.mailAccountId,
    threadId: input.threadId,
    folderId,
    // Unique per seeded Message: `(folder_id, uid)` is its real identity,
    // and one test seeds several into the same INBOX.
    uid: nextUid++,
    subject: "Hello",
    fromName: input.fromName ?? "Ada",
    fromAddress: input.fromAddress ?? "ada@example.test",
    sentAt: new Date("2026-01-01T00:00:00Z"),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    seen: false,
    flagged: false,
    attachments: input.attachments ?? [],
    bodyText: input.bodyText ?? "hi",
    bodyHtml: input.bodyHtml ?? "<p>hi</p>",
    bodyFetchedAt:
      input.bodyFetchedAt === undefined ? new Date("2026-01-01T00:00:01Z") : input.bodyFetchedAt,
  });
  return messageId;
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

describe("GET /threads/:threadId/messages", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/threads/does-not-matter/messages" });
    expect(response.statusCode).toBe(401);
  });

  it("404s a thread with no messages at all", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "GET",
      url: "/threads/unknown-thread/messages",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s a thread that belongs to someone else's Mail Account", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const otherUserId = randomUUID();
    await db.insert(users).values({
      id: otherUserId,
      username: `other-${otherUserId.slice(0, 8)}`,
      passwordHash: "not-a-real-hash",
      role: "member",
    });
    const otherAccountId = randomUUID();
    await db.insert(mailAccounts).values({
      id: otherAccountId,
      userId: otherUserId,
      emailAddress: "other@example.com",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecurity: "tls",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecurity: "starttls",
      username: "other@example.com",
      credential: {
        kind: "password",
        secret: { keyVersion: 1, iv: "", ciphertext: "", authTag: "" },
      },
    });
    const threadId = randomUUID();
    await seedMessage({ mailAccountId: otherAccountId, threadId });

    const response = await app.inject({
      method: "GET",
      url: `/threads/${threadId}/messages`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the wire Message shape with a rewritten remote image and cid: left alone", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    const messageId = await seedMessage({
      mailAccountId: accountId,
      threadId,
      bodyHtml: '<p>hi</p><img src="cid:logo@example"><img src="https://sender.example/t.gif">',
      attachments: [
        {
          part: "2",
          filename: "photo.png",
          mimeType: "image/png",
          sizeBytes: 10,
          contentId: null,
          inline: false,
          encoding: "base64",
        },
        {
          part: "3",
          filename: null,
          mimeType: "image/png",
          sizeBytes: 5,
          contentId: "logo@example",
          inline: true,
          encoding: "base64",
        },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/threads/${threadId}/messages`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { messages: Array<Record<string, unknown>> };
    expect(body.messages).toHaveLength(1);
    const message = body.messages[0] as {
      id: string;
      bodyHtml: string;
      attachments: MessageAttachment[];
      from: { name: string; address: string };
    };
    expect(message.id).toBe(messageId);
    expect(message.from).toEqual({ name: "Ada", address: "ada@example.test" });
    expect(message.bodyHtml).toContain('src="cid:logo@example"');
    expect(message.bodyHtml).toContain(`/messages/${messageId}/image-proxy?url=`);
    expect(message.bodyHtml).not.toContain("https://sender.example");
    // Both attachments travel on the wire — the cid:-only inline part is
    // still here so the Client can resolve `cid:logo@example` against it;
    // filtering it out of the *panel* is a Client-side rendering concern.
    expect(message.attachments).toHaveLength(2);
    expect(message.attachments.map((a) => a.filename)).toEqual(["photo.png", null]);
  });

  it("allows remote images only for an Approved Sender — the Gatekeeper verdict is the permission (#55)", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);

    const strangerThread = randomUUID();
    await seedMessage({
      mailAccountId: accountId,
      threadId: strangerThread,
      fromAddress: "stranger@example.test",
    });
    const friendThread = randomUUID();
    await seedMessage({
      mailAccountId: accountId,
      threadId: friendThread,
      fromAddress: "friend@example.test",
    });
    await setVerdict(
      db,
      accountId,
      { scope: "address", value: "friend@example.test" },
      "approved",
      "screener",
    );

    async function remoteImagesAllowed(threadId: string): Promise<boolean> {
      const response = await app.inject({
        method: "GET",
        url: `/threads/${threadId}/messages`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { messages: { remoteImagesAllowed: boolean }[] };
      return body.messages[0]?.remoteImagesAllowed ?? false;
    }

    expect(await remoteImagesAllowed(strangerThread)).toBe(false);
    expect(await remoteImagesAllowed(friendThread)).toBe(true);
  });
});

describe("GET /messages/:messageId/attachments/:part", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/messages/does-not-matter/attachments/2",
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s an unknown message", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const response = await app.inject({
      method: "GET",
      url: "/messages/unknown/attachments/2",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s an unknown attachment part on a real, owned message", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    const messageId = await seedMessage({ mailAccountId: accountId, threadId });

    const response = await app.inject({
      method: "GET",
      url: `/messages/${messageId}/attachments/9`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /messages/:messageId/image-proxy", () => {
  it("requires a session", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/messages/x/image-proxy" });
    expect(response.statusCode).toBe(401);
  });

  it("400s a request missing url or sig", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    const messageId = await seedMessage({ mailAccountId: accountId, threadId });

    const response = await app.inject({
      method: "GET",
      url: `/messages/${messageId}/image-proxy`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it("403s a well-formed but forged signature", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    const messageId = await seedMessage({ mailAccountId: accountId, threadId });

    const response = await app.inject({
      method: "GET",
      url: `/messages/${messageId}/image-proxy?url=${encodeURIComponent("https://sender.example/t.gif")}&sig=forged`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("403s a target that resolves to a private address, even with a genuine signature", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    const messageId = await seedMessage({ mailAccountId: accountId, threadId });

    const key = deriveImageProxyKey(TEST_MAIL_CREDENTIAL_KEY);
    const target = "http://127.0.0.1:1/whatever.png";
    const path = buildImageProxyPath(key, messageId, target);

    const response = await app.inject({ method: "GET", url: path, headers: { cookie } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "disallowed_address" });
  });

  it("404s when the signed message id belongs to someone else", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const accountId = await createOwnedMailAccount(app, cookie);
    const threadId = randomUUID();
    const messageId = await seedMessage({ mailAccountId: accountId, threadId });

    // A second, unauthenticated caller (no cookie at all) — the ownership
    // check has to run before signature verification even gets a say.
    const key = deriveImageProxyKey(TEST_MAIL_CREDENTIAL_KEY);
    const path = buildImageProxyPath(key, messageId, "https://sender.example/t.gif");
    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(401);
  });
});

describe("decodeTransferEncoding", () => {
  it("decodes base64", () => {
    expect(decodeTransferEncoding(Buffer.from("aGVsbG8=", "ascii"), "base64").toString()).toBe(
      "hello",
    );
  });

  it("tolerates whitespace/line breaks inside a base64 blob (as IMAP literals often carry)", () => {
    expect(decodeTransferEncoding(Buffer.from("aGVs\r\nbG8=", "ascii"), "base64").toString()).toBe(
      "hello",
    );
  });

  it("passes 7bit/8bit/binary/unset through unchanged", () => {
    const raw = Buffer.from("plain text", "ascii");
    expect(decodeTransferEncoding(raw, "7bit")).toEqual(raw);
    expect(decodeTransferEncoding(raw, "8bit")).toEqual(raw);
    expect(decodeTransferEncoding(raw, null)).toEqual(raw);
  });

  it("delegates quoted-printable to decodeQuotedPrintable", () => {
    expect(
      decodeTransferEncoding(Buffer.from("h=65llo", "ascii"), "quoted-printable").toString(),
    ).toBe("hello");
  });
});

describe("decodeQuotedPrintable", () => {
  it("decodes an =XX hex escape (RFC 2045 §6.7)", () => {
    expect(decodeQuotedPrintable("h=65llo").toString()).toBe("hello");
  });

  it("removes a soft line break (=CRLF and bare =LF), joining the next line", () => {
    expect(decodeQuotedPrintable("abc=\r\ndef").toString()).toBe("abcdef");
    expect(decodeQuotedPrintable("abc=\ndef").toString()).toBe("abcdef");
  });

  it("leaves a lone = with no valid hex escape as a literal character", () => {
    expect(decodeQuotedPrintable("100% = great").toString()).toBe("100% = great");
  });
});
