import { describe, expect, it } from "vitest";
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
