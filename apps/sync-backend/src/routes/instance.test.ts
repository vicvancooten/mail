import { randomUUID } from "node:crypto";
import type { MailAccountConnection } from "@mail/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/sessions.js";
import type { Db } from "../db/client.js";
import { mailAccounts, notifierOutbox, users } from "../db/schema.js";
import { deriveCredentialKey, sealSecret } from "../mail-accounts/credential-crypto.js";
import { getMailAccountById } from "../mail-accounts/store.js";
import {
  recordProviderRefreshOutcome,
  upsertProviderRegistration,
} from "../provider-registrations/store.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * `GET /instance/health` (#104, #115): the Owner-only Instance page's data
 * source, plus #115's Provider Registration CRUD sharing the same
 * `/instance` prefix.
 */

const PUBLIC_URL = "http://localhost:3000";
const CONNECTION: MailAccountConnection = { host: "imap.example.com", port: 993, security: "tls" };

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

/** A Mail Account whose `oauth` credential names `provider` — what `/instance/providers/:provider`'s counts and delete transition target. */
async function createOauthMailAccount(
  provider: "google" | "microsoft",
  status: "active" | "needs_reauth" = "active",
): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    username: `user-${userId}`,
    passwordHash: "not-a-real-hash",
    role: "member",
  });
  const id = randomUUID();
  const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
  await db.insert(mailAccounts).values({
    id,
    userId,
    emailAddress: `${id}@example.com`,
    imapHost: CONNECTION.host,
    imapPort: CONNECTION.port,
    imapSecurity: CONNECTION.security,
    smtpHost: CONNECTION.host,
    smtpPort: 587,
    smtpSecurity: "starttls",
    username: `${id}@example.com`,
    status,
    credential: {
      kind: "oauth",
      provider,
      accessToken: sealSecret("at", provider, key),
      refreshToken: sealSecret("rt", provider, key),
      expiresAt: new Date().toISOString(),
      scope: [],
    },
  });
  return id;
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

  it("reports both Providers as not_registered with a redirect URI derived from PUBLIC_URL, before any Registration exists", async () => {
    const app = buildTestApp({ publicUrl: "https://mail.example.com" });
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(response.json()).toMatchObject({
      providers: [
        {
          provider: "google",
          status: "not_registered",
          redirectUri: "https://mail.example.com/auth/oauth/google/callback",
          clientIdPreview: null,
          mailAccountCount: 0,
          needsReauthCount: 0,
          lastRefreshAt: null,
          lastRefreshError: null,
        },
        {
          provider: "microsoft",
          status: "not_registered",
          redirectUri: "https://mail.example.com/auth/oauth/microsoft/callback",
          clientIdPreview: null,
        },
      ],
    });
  });

  it("reports working with lastRefreshAt after a successful Grant refresh", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    await upsertProviderRegistration(
      db,
      "google",
      "client-id",
      sealSecret("secret", "google", key),
    );
    await recordProviderRefreshOutcome(db, "google", null);

    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    const google = response
      .json()
      .providers.find((p: { provider: string }) => p.provider === "google");
    expect(google.status).toBe("working");
    expect(google.lastRefreshAt).not.toBeNull();
    expect(google.lastRefreshError).toBeNull();
  });

  it("reports failing with lastRefreshError after a transient Grant refresh failure", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    await upsertProviderRegistration(
      db,
      "google",
      "client-id",
      sealSecret("secret", "google", key),
    );
    await recordProviderRefreshOutcome(db, "google", "network blip");

    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    const google = response
      .json()
      .providers.find((p: { provider: string }) => p.provider === "google");
    expect(google.status).toBe("failing");
    expect(google.lastRefreshError).toBe("network blip");
  });

  it("a later successful refresh clears failing back to working", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    const key = deriveCredentialKey(TEST_MAIL_CREDENTIAL_KEY);
    await upsertProviderRegistration(
      db,
      "google",
      "client-id",
      sealSecret("secret", "google", key),
    );
    await recordProviderRefreshOutcome(db, "google", "network blip");
    await recordProviderRefreshOutcome(db, "google", null);

    const response = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    const google = response
      .json()
      .providers.find((p: { provider: string }) => p.provider === "google");
    expect(google.status).toBe("working");
    expect(google.lastRefreshError).toBeNull();
  });
});

describe("PUT /instance/providers/:provider", () => {
  it("401s unauthenticated", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "PUT",
      url: "/instance/providers/google",
      payload: { clientId: "id", clientSecret: "secret" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("403s a Member", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("member");
    const response = await app.inject({
      method: "PUT",
      url: "/instance/providers/google",
      headers: { cookie },
      payload: { clientId: "id", clientSecret: "secret" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("400s an unknown provider", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "PUT",
      url: "/instance/providers/yahoo",
      headers: { cookie },
      payload: { clientId: "id", clientSecret: "secret" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s a missing client id or secret", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "PUT",
      url: "/instance/providers/google",
      headers: { cookie },
      payload: { clientId: "", clientSecret: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("saves a Registration, moving status to registered_untested and echoing the client id but never the secret", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    const response = await app.inject({
      method: "PUT",
      url: "/instance/providers/google",
      headers: { cookie },
      payload: {
        clientId: "client-123.apps.googleusercontent.com",
        clientSecret: "shh-its-a-secret",
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.provider).toMatchObject({
      provider: "google",
      status: "registered_untested",
      clientIdPreview: "client-123.apps.googleusercontent.com",
    });
    expect(JSON.stringify(body)).not.toContain("shh-its-a-secret");

    // And it sticks: a fresh health read shows the same thing.
    const health = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(health.json().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "google", status: "registered_untested" }),
      ]),
    );
  });

  it("replaces an existing Registration rather than erroring on a second save", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    await app.inject({
      method: "PUT",
      url: "/instance/providers/google",
      headers: { cookie },
      payload: { clientId: "first-id", clientSecret: "first-secret" },
    });
    const second = await app.inject({
      method: "PUT",
      url: "/instance/providers/google",
      headers: { cookie },
      payload: { clientId: "second-id", clientSecret: "second-secret" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().provider).toMatchObject({ clientIdPreview: "second-id" });
  });
});

describe("GET /instance/providers/:provider/delete-preview", () => {
  it("401s unauthenticated", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/instance/providers/google/delete-preview",
    });
    expect(response.statusCode).toBe(401);
  });

  it("403s a Member", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("member");
    const response = await app.inject({
      method: "GET",
      url: "/instance/providers/google/delete-preview",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("counts the Mail Accounts on that Provider without transitioning anything", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    await createOauthMailAccount("google");
    await createOauthMailAccount("google");
    await createOauthMailAccount("microsoft");

    const response = await app.inject({
      method: "GET",
      url: "/instance/providers/google/delete-preview",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mailAccountCount: 2 });
  });
});

describe("DELETE /instance/providers/:provider", () => {
  it("401s unauthenticated", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "DELETE", url: "/instance/providers/google" });
    expect(response.statusCode).toBe(401);
  });

  it("403s a Member", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("member");
    const response = await app.inject({
      method: "DELETE",
      url: "/instance/providers/google",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("removes the Registration and parks its Mail Accounts in Needs Reauth, one notification each", async () => {
    const app = buildTestApp();
    const cookie = await createUserWithCookie("owner");
    await app.inject({
      method: "PUT",
      url: "/instance/providers/google",
      headers: { cookie },
      payload: { clientId: "id", clientSecret: "secret" },
    });
    const activeId = await createOauthMailAccount("google", "active");
    const alreadyParkedId = await createOauthMailAccount("google", "needs_reauth");
    const otherProviderId = await createOauthMailAccount("microsoft", "active");

    const response = await app.inject({
      method: "DELETE",
      url: "/instance/providers/google",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mailAccountCount: 2 });

    expect((await getMailAccountById(db, activeId))?.status).toBe("needs_reauth");
    expect((await getMailAccountById(db, otherProviderId))?.status).toBe("active");

    // One notification for the account that actually transitioned...
    const activeNotifications = await db
      .select()
      .from(notifierOutbox)
      .where(eq(notifierOutbox.mailAccountId, activeId));
    expect(activeNotifications).toHaveLength(1);
    expect(activeNotifications[0]?.kind).toBe("needs_reauth");

    // ...and none for the one already parked (markNeedsReauth's own guard).
    const alreadyParkedNotifications = await db
      .select()
      .from(notifierOutbox)
      .where(eq(notifierOutbox.mailAccountId, alreadyParkedId));
    expect(alreadyParkedNotifications).toHaveLength(0);

    // The Registration itself is gone.
    const health = await app.inject({
      method: "GET",
      url: "/instance/health",
      headers: { cookie },
    });
    expect(health.json().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "google", status: "not_registered" }),
      ]),
    );
  });
});
