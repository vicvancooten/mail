import { createHash } from "node:crypto";
import { EMPTY_CONTACT_FIELDS, generateUlid } from "@mail/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ensureLocalAddressBookId } from "../address-books/store.js";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { createSession } from "../auth/sessions.js";
import { insertContact } from "../contacts/store.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * The Contact photo Blob Store's own HTTP surface (#213): upload/download/
 * remove over `app.inject`, `routes/attachments.test.ts`'s own shape.
 * Content-addressing and orphan collection get their own unit coverage in
 * `contacts/photo-store.test.ts`; this is ownership, the mime/size bounds,
 * and the plain CRUD.
 */

const PUBLIC_URL = "http://localhost:3000";
const PNG_BYTES = Buffer.from("not a real png, just bytes");

let db: Db;
let closeDb: () => Promise<void>;

function buildTestApp(contactPhotoMaxBytes?: number) {
  return buildApp({
    db,
    publicUrl: PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    contactPhotoMaxBytes,
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

/** A fresh Local Contact this User owns, for the photo routes to act on. */
async function createOwnedContact(app: FastifyInstance, cookie: string): Promise<string> {
  const sessionResponse = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie },
  });
  const userId = (sessionResponse.json().user as { id: string }).id;
  const addressBookId = await ensureLocalAddressBookId(db, userId);
  const contactId = generateUlid();
  await insertContact(db, userId, addressBookId, contactId, EMPTY_CONTACT_FIELDS);
  return contactId;
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

describe("POST /contacts/:contactId/photo", () => {
  it("uploads bytes, content-addressed, and returns the photo reference", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/contacts/${contactId}/photo?mimeType=image%2Fpng`,
      headers: { cookie, "content-type": "image/png" },
      payload: PNG_BYTES,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mimeType).toBe("image/png");
    expect(body.blobId).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
  });

  it("rejects an unsupported mime type", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/contacts/${contactId}/photo?mimeType=text%2Fplain`,
      headers: { cookie, "content-type": "text/plain" },
      payload: Buffer.from("not an image"),
    });
    expect(response.statusCode).toBe(415);
  });

  it("rejects a Contact this User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/contacts/not-mine/photo?mimeType=image%2Fpng",
      headers: { cookie, "content-type": "image/png" },
      payload: PNG_BYTES,
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects an unauthenticated upload", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/contacts/c1/photo?mimeType=image%2Fpng",
      headers: { "content-type": "image/png" },
      payload: PNG_BYTES,
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects over the size budget", async () => {
    const app = buildTestApp(10);
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);

    const response = await app.inject({
      method: "POST",
      url: `/contacts/${contactId}/photo?mimeType=image%2Fpng`,
      headers: { cookie, "content-type": "image/png" },
      payload: Buffer.alloc(100),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: "photo_too_large", maxBytes: 10 });
  });

  it("replacing a photo changes the served bytes to the new upload", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);
    const replacement = Buffer.from("a different image entirely");

    await app.inject({
      method: "POST",
      url: `/contacts/${contactId}/photo?mimeType=image%2Fpng`,
      headers: { cookie, "content-type": "image/png" },
      payload: PNG_BYTES,
    });
    await app.inject({
      method: "POST",
      url: `/contacts/${contactId}/photo?mimeType=image%2Fpng`,
      headers: { cookie, "content-type": "image/png" },
      payload: replacement,
    });

    const after = await app.inject({
      method: "GET",
      url: `/contacts/${contactId}/photo`,
      headers: { cookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.rawPayload.equals(replacement)).toBe(true);
  });
});

describe("GET and DELETE /contacts/:contactId/photo", () => {
  async function upload(app: FastifyInstance, cookie: string, contactId: string) {
    const response = await app.inject({
      method: "POST",
      url: `/contacts/${contactId}/photo?mimeType=image%2Fpng`,
      headers: { cookie, "content-type": "image/png" },
      payload: PNG_BYTES,
    });
    return response.json() as { blobId: string; mimeType: string };
  }

  it("downloads the exact bytes back, with the content type", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);
    await upload(app, cookie, contactId);

    const response = await app.inject({
      method: "GET",
      url: `/contacts/${contactId}/photo`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload.equals(PNG_BYTES)).toBe(true);
  });

  it("404s for a Contact with no photo set", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);

    const response = await app.inject({
      method: "GET",
      url: `/contacts/${contactId}/photo`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires a session to download", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);
    await upload(app, cookie, contactId);

    const response = await app.inject({ method: "GET", url: `/contacts/${contactId}/photo` });
    expect(response.statusCode).toBe(401);
  });

  it("a second User cannot download this Contact's photo (#213's own ownership acceptance line)", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);
    await upload(app, cookie, contactId);

    const otherUserId = generateUlid();
    await db.insert(users).values({
      id: otherUserId,
      username: `other-${otherUserId.slice(0, 8)}`,
      passwordHash: "not-a-real-hash",
      role: "member",
    });
    const { token } = await createSession(db, otherUserId);

    const response = await app.inject({
      method: "GET",
      url: `/contacts/${contactId}/photo`,
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("removes the photo reference", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    const contactId = await createOwnedContact(app, cookie);
    await upload(app, cookie, contactId);

    const del = await app.inject({
      method: "DELETE",
      url: `/contacts/${contactId}/photo`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/contacts/${contactId}/photo`,
      headers: { cookie },
    });
    expect(after.statusCode).toBe(404);
  });

  it("404s removing the photo of a Contact this User does not own", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);

    const del = await app.inject({
      method: "DELETE",
      url: "/contacts/not-mine/photo",
      headers: { cookie },
    });
    expect(del.statusCode).toBe(404);
  });
});
