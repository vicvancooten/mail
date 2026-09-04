import { describe, expect, it } from "vitest";
import { resolveRecipientAlias } from "./alias.js";

/** Builds a raw RFC 5322 header block the way ImapFlow hands one back for `fetch(..., { headers: [...] })`. */
function headerBlock(lines: string[]): Buffer {
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

const ACCOUNT = "wicket@mycompany.com";

describe("resolveRecipientAlias (#103)", () => {
  it("prefers Delivered-To over everything else", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: headerBlock([
        "Delivered-To: sales@mycompany.com",
        "X-Original-To: support@mycompany.com",
      ]),
      toAddresses: [{ name: null, address: "someone-else@mycompany.com" }],
      ccAddresses: [],
    });
    expect(alias).toBe("sales@mycompany.com");
  });

  it("falls back to X-Original-To when Delivered-To is absent", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: headerBlock(["X-Original-To: support@mycompany.com"]),
      toAddresses: [],
      ccAddresses: [],
    });
    expect(alias).toBe("support@mycompany.com");
  });

  it("falls back to To/Cc — spam to a catch-all usually arrives Bcc'd, but plain mail still resolves", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: undefined,
      toAddresses: [{ name: null, address: "friend@theirdomain.com" }],
      ccAddresses: [{ name: null, address: "catchall@mycompany.com" }],
    });
    expect(alias).toBe("catchall@mycompany.com");
  });

  it("discards a Delivered-To that names a different domain — noise, not this mailbox's own Alias", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: headerBlock(["Delivered-To: someone@unrelated.example"]),
      toAddresses: [{ name: null, address: "catchall@mycompany.com" }],
      ccAddresses: [],
    });
    expect(alias).toBe("catchall@mycompany.com");
  });

  it("resolves the account's own primary address when that's genuinely what the message named", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: undefined,
      toAddresses: [{ name: null, address: "Wicket@MyCompany.com" }],
      ccAddresses: [],
    });
    expect(alias).toBe("wicket@mycompany.com");
  });

  it("returns null when nothing names an address at the account's own domain", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: undefined,
      toAddresses: [{ name: null, address: "friend@theirdomain.com" }],
      ccAddresses: [{ name: null, address: "another@elsewhere.com" }],
    });
    expect(alias).toBeNull();
  });

  it("returns null for an account address with no parseable domain", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: "not-an-address",
      headerBlock: headerBlock(["Delivered-To: sales@mycompany.com"]),
      toAddresses: [],
      ccAddresses: [],
    });
    expect(alias).toBeNull();
  });

  it("normalizes case and trims the header value", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: headerBlock(["Delivered-To:  <Sales@MyCompany.com>  "]),
      toAddresses: [],
      ccAddresses: [],
    });
    expect(alias).toBe("sales@mycompany.com");
  });
});
