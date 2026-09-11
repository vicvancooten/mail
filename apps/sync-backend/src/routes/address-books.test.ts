import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { addressBooks } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";
import { createTestMailAccount } from "../test-support/mail-account.js";

const PUBLIC_URL = "http://localhost:3000";

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

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("no Set-Cookie header on response");
  return raw.split(";")[0] ?? raw;
}

async function claimOwner(app: FastifyInstance): Promise<{ cookie: string; userId: string }> {
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
  const cookie = extractCookie(response.headers["set-cookie"]);
  const userId = (response.json() as { user: { id: string } }).user.id;
  return { cookie, userId };
}

function buildTestApp() {
  return buildApp({ db, publicUrl: PUBLIC_URL, mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });
}

async function insertMirroredAddressBook(
  userId: string,
  connectedAccountId: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(addressBooks).values({
    id,
    userId,
    connectedAccountId,
    name: "Google Contacts",
    capabilityTableId: "google",
    mirrored: true,
    isDefault: false,
  });
  return id;
}

describe("/address-books/:id/unmirror, /mirror, /unmirror-impact", () => {
  it("requires auth", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/address-books/does-not-exist/unmirror",
    });
    expect(response.statusCode).toBe(401);
  });

  it("404s for an Address Book id that isn't this User's", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);

    const response = await app.inject({
      method: "POST",
      url: "/address-books/no-such-book/unmirror",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s attempting to unmirror the Local Address Book", async () => {
    const app = buildTestApp();
    const { cookie } = await claimOwner(app);
    // Ensures the Local Address Book exists, the same way an ordinary `AddressBook` sync round does.
    await app.inject({
      method: "POST",
      url: "/sync",
      headers: { cookie },
      payload: { user: { AddressBook: null } },
    });

    const [local] = await db.select().from(addressBooks);
    const response = await app.inject({
      method: "POST",
      url: `/address-books/${local?.id}/unmirror`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "not_mirrorable" });
  });

  it("previews, then unmirrors, and flips mirrored back on with /mirror", async () => {
    const app = buildTestApp();
    const { cookie, userId } = await claimOwner(app);
    const { connectedAccountId } = await createTestMailAccount(db, { userId });
    const addressBookId = await insertMirroredAddressBook(userId, connectedAccountId);

    const preview = await app.inject({
      method: "GET",
      url: `/address-books/${addressBookId}/unmirror-impact`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ discarded: { contacts: 0 } });

    const unmirrored = await app.inject({
      method: "POST",
      url: `/address-books/${addressBookId}/unmirror`,
      headers: { cookie },
    });
    expect(unmirrored.statusCode).toBe(200);
    const unmirroredBody = unmirrored.json() as { addressBook: { mirrored: boolean } };
    expect(unmirroredBody.addressBook.mirrored).toBe(false);

    const remirrored = await app.inject({
      method: "POST",
      url: `/address-books/${addressBookId}/mirror`,
      headers: { cookie },
    });
    expect(remirrored.statusCode).toBe(200);
    const remirroredBody = remirrored.json() as { addressBook: { mirrored: boolean } };
    expect(remirroredBody.addressBook.mirrored).toBe(true);
  });
});
