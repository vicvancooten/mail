import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createTestDb, TEST_MAIL_CREDENTIAL_KEY } from "./test-support/db.js";

describe("GET /healthz", () => {
  it("reports ok", async () => {
    const { db, sql } = await createTestDb();
    const app = buildApp({
      db,
      publicUrl: "http://localhost:3000",
      mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
    });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
    await sql.end();
  });
});

// #92: reloading a client-side route in the built image must land on the
// app shell, not Fastify's bare 404 — see `setNotFoundHandler` in `app.ts`.
describe("SPA fallback", () => {
  let publicDir: string | undefined;

  afterEach(() => {
    if (publicDir) rmSync(publicDir, { recursive: true, force: true });
    publicDir = undefined;
  });

  function buildAppWithShell() {
    publicDir = mkdtempSync(join(tmpdir(), "mail-spa-fallback-"));
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>shell</title>");
    return async () => {
      const { db, sql } = await createTestDb();
      const app = buildApp({
        db,
        publicUrl: "http://localhost:3000",
        mailCredentialKey: TEST_MAIL_CREDENTIAL_KEY,
        publicDir,
      });
      return { app, sql };
    };
  }

  it("serves the shell for an unmatched client route requesting HTML", async () => {
    const { app, sql } = await buildAppWithShell()();
    const response = await app.inject({
      method: "GET",
      url: "/mail?thread=x",
      headers: { accept: "text/html" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("shell");
    await sql.end();
  });

  it("still 404s an unmatched API path as JSON", async () => {
    const { app, sql } = await buildAppWithShell()();
    const response = await app.inject({
      method: "GET",
      url: "/sync/nope",
      headers: { accept: "text/html" },
    });

    it("still 404s an unmatched /instance API path as JSON", async () => {
      const { app, sql } = await buildAppWithShell()();
      const response = await app.inject({
        method: "GET",
        url: "/instance/nope",
        headers: { accept: "text/html" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "Not Found" });
      await sql.end();
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Not Found" });
    await sql.end();
  });

  it("404s a non-HTML miss as JSON rather than serving the shell", async () => {
    const { app, sql } = await buildAppWithShell()();
    const response = await app.inject({
      method: "GET",
      url: "/nonexistent.js",
      headers: { accept: "*/*" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Not Found" });
    await sql.end();
  });
});
