import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/sessions.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createVapidKeyStore, type VapidKeyStore } from "../notifier/vapid-keys.js";
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
  options: { vapidKeys?: VapidKeyStore; publicUrl?: string; imageTag?: string } = {},
) {
  return buildApp({
    db,
    publicUrl: options.publicUrl ?? PUBLIC_URL,
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    vapidKeys: options.vapidKeys,
    imageTag: options.imageTag ?? "test-tag",
  });
}

/** The real store, over this test's own database — what `main.ts` wires in. */
function realVapidKeys(overrides: { envKeypair?: { publicKey: string; privateKey: string } } = {}) {
  return createVapidKeyStore(db, {
    mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    envKeypair: overrides.envKeypair ?? null,
    generate: () => ({ publicKey: "generated-public", privateKey: "generated-private" }),
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
    const app = buildTestApp({ imageTag: "sha-abc123" });
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
    const app = buildTestApp({
      vapidKeys: realVapidKeys({
        envKeypair: { publicKey: "test-key", privateKey: "test-private" },
      }),
    });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({ webPush: { configured: true } });
  });

  it("says it can generate the keypair itself when the environment doesn't pin one", async () => {
    const app = buildTestApp({ vapidKeys: realVapidKeys() });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({
      webPush: { configured: false, canGenerate: true },
    });
  });

  it("says it cannot generate on an env-pinned instance, where a button would be overridden on the next boot", async () => {
    const app = buildTestApp({
      vapidKeys: realVapidKeys({
        envKeypair: { publicKey: "env-public", privateKey: "env-private" },
      }),
    });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({
      webPush: { configured: true, canGenerate: false },
    });
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

  it("treats an invalid PUBLIC_URL value as not a secure context", async () => {
    const app = buildTestApp({ publicUrl: "not-a-url" });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({
      publicUrl: { value: "not-a-url", isSecureContext: false },
    });
  });
});

describe("POST /instance/vapid-keys", () => {
  it("mints the keypair and reports it, so Web Push works without a shell", async () => {
    const app = buildTestApp({ vapidKeys: realVapidKeys() });
    const cookie = await createUserWithCookie("owner");

    const response = await app.inject({
      method: "POST",
      url: "/instance/vapid-keys",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ publicKey: "generated-public", replaced: false });

    // And the Client's own read of it agrees immediately — no restart.
    const config = await app.inject({ method: "GET", url: "/push/config", headers: { cookie } });
    expect(config.json()).toEqual({ vapidPublicKey: "generated-public" });
  });

  it("is idempotent: a second press answers with the same keypair rather than invalidating every subscription", async () => {
    const app = buildTestApp({ vapidKeys: realVapidKeys() });
    const cookie = await createUserWithCookie("owner");

    const first = await app.inject({
      method: "POST",
      url: "/instance/vapid-keys",
      headers: { cookie },
    });
    const second = await app.inject({
      method: "POST",
      url: "/instance/vapid-keys",
      headers: { cookie },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it("refuses on an env-pinned instance, which would override whatever it wrote", async () => {
    const app = buildTestApp({
      vapidKeys: realVapidKeys({
        envKeypair: { publicKey: "env-public", privateKey: "env-private" },
      }),
    });
    const cookie = await createUserWithCookie("owner");

    const response = await app.inject({
      method: "POST",
      url: "/instance/vapid-keys",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "env_managed" });
  });

  it("is Owner-only, like every other fact on this page", async () => {
    const app = buildTestApp({ vapidKeys: realVapidKeys() });
    const cookie = await createUserWithCookie("member");

    const response = await app.inject({
      method: "POST",
      url: "/instance/vapid-keys",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });
});
