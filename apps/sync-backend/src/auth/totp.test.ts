import { generate } from "otplib";
import { describe, expect, it } from "vitest";
import { generateTotpSecret, totpAuthUri, verifyTotpCode } from "./totp.js";

describe("generateTotpSecret / totpAuthUri", () => {
  it("produces a base32 secret and a matching otpauth:// URI", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);

    const uri = totpAuthUri("vic", secret);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Mail:vic\?/);
    expect(uri).toContain(`secret=${secret}`);
  });
});

describe("verifyTotpCode", () => {
  it("accepts the current code", async () => {
    const secret = generateTotpSecret();
    const code = await generate({ secret });

    const result = await verifyTotpCode(secret, code);
    expect(result.valid).toBe(true);
  });

  it("rejects a wrong code", async () => {
    const secret = generateTotpSecret();

    const result = await verifyTotpCode(secret, "000000");
    expect(result.valid).toBe(false);
  });

  it("rejects a code once its time step has already been spent", async () => {
    const secret = generateTotpSecret();
    const code = await generate({ secret });

    const first = await verifyTotpCode(secret, code);
    expect(first.valid).toBe(true);
    if (!first.valid) throw new Error("unreachable");

    const replay = await verifyTotpCode(secret, code, first.timeStep);
    expect(replay.valid).toBe(false);
  });
});
