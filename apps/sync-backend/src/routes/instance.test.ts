import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/sessions.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/** `GET /instance/health` (#104): the Owner-only Instance page's one route. */

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

function buildTestApp(
  options: { vapidPublicKey?: string | null; publicUrl?: string; imageTag?: string } = {},
) {
  return buildApp({
    db,
    publicUrl: options.publicUrl ?? PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    vapidPublicKey: options.vapidPublicKey ?? null,
    imageTag: options.imageTag ?? "test-tag",
  });
}

async function createUserWithCookie(role: "owner" | "member"): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId}`,
    passwordHash: "not-a-real-hash",
    role,
  });
  const { token } = await createSession(db, userId);
  return `mail_session=${token}`;
}

describe("GET /instance/health", () => {
  it("401s unauthenticated", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/instance/health" });
    expect(response.statusCode).toBe(401);
  });

  it("403s a Member", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("member");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("reports Web Push unconfigured with the exact generate command, and System Mailer unconfigured", async () => {
    const app = buildTestApp({ vapidPublicKey: null, imageTag: "sha-abc123" });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      imageTag: "sha-abc123",
      webPush: { configured: false, generateCommand: "mail generate-vapid-keys" },
      systemMailer: { configured: false },
    });
  });

  it("reports Web Push configured when a VAPID public key is set", async () => {
    const app = buildTestApp({ vapidPublicKey: "test-key" });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({ webPush: { configured: true } });
  });

  it("flags a non-localhost http:// PUBLIC_URL as not a secure context", async () => {
    const app = buildTestApp({ publicUrl: "http://mail.example.com" });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({
      publicUrl: { value: "http://mail.example.com", isSecureContext: false },
    });
  });

  it("treats http://localhost as a secure context", async () => {
    const app = buildTestApp({ publicUrl: "http://localhost:3000" });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({
      publicUrl: { isSecureContext: true },
    });
  });
});
