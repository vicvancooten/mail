import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ensureClaimToken } from "../auth/claim.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createTestDb, resetTestDb, TEST_MAIL_CREDENTIAL_KEY } from "../test-support/db.js";

/**
 * The Undo Send delay's own routes (#46). The interesting behaviour is not the
 * plumbing but the two guardrails: the default is 10s with nothing stored, and
 * a value outside `off/5/10/20/30` is refused rather than producing a window
 * no UI can describe.
 */

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

function buildTestApp() {
  return buildApp({ db, publicUrl: PUBLIC_URL, mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY });
}

describe("/send-settings", () => {
  it("defaults to a 10s Undo Send window (poc-spec.md §Preferences)", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "GET",
      url: "/send-settings",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ undoSendDelaySeconds: 10 });
  });

  it("round-trips every offered value, `off` included", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);

    for (const seconds of [0, 5, 10, 20, 30]) {
      const patched = await app.inject({
        method: "PATCH",
        url: "/send-settings",
        headers: { cookie },
        payload: { undoSendDelaySeconds: seconds },
      });
      expect(patched.json()).toEqual({ undoSendDelaySeconds: seconds });

      const read = await app.inject({ method: "GET", url: "/send-settings", headers: { cookie } });
      expect(read.json()).toEqual({ undoSendDelaySeconds: seconds });
    }
  });

  it("refuses a delay outside the offered set", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/send-settings",
      headers: { cookie },
      payload: { undoSendDelaySeconds: 7 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  it("falls back to the default rather than reporting a stored value it cannot describe", async () => {
    const app = buildTestApp();
    const cookie = await claimOwner(app);
    await db.update(users).set({ undoSendDelaySeconds: 7 }).where(eq(users.username, "vic"));

    const response = await app.inject({
      method: "GET",
      url: "/send-settings",
      headers: { cookie },
    });
    expect(response.json()).toEqual({ undoSendDelaySeconds: 10 });
  });

  it("requires a session", async () => {
    const app = buildTestApp();
    expect((await app.inject({ method: "GET", url: "/send-settings" })).statusCode).toBe(401);
  });
});
