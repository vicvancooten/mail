import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /healthz", () => {
  it("reports ok", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });
});
