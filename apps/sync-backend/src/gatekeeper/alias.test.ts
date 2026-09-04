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

  it("accepts a Delivered-To at a different domain than the Mail Account's own login address — the leaked-catch-all case #103 exists for", () => {
    // The ticket's own Problem statement: a catch-all domain handed out per
    // correspondent has no reason to share a domain with the Mail Account's
    // login address. An earlier revision required every candidate to match
    // that login domain, which discarded exactly this Alias — #90's review
    // caught it as an undeclared constraint the ticket's Decision never
    // named.
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: headerBlock(["Delivered-To: somecompany@theirdomain.com"]),
      toAddresses: [{ name: null, address: "catchall@mycompany.com" }],
      ccAddresses: [],
    });
    expect(alias).toBe("somecompany@theirdomain.com");
  });

  it("still requires a To/Cc fallback candidate to sit at the Mail Account's own domain — the weak-evidence tier", () => {
    // Unlike a header stamp, a `To`/`Cc` entry carries no MDA behind it
    // vouching for it — a co-recipient's own address sitting there must
    // never become "my Alias", which is exactly what the domain gate still
    // guards for this tier.
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: ACCOUNT,
      headerBlock: undefined,
      toAddresses: [{ name: null, address: "co-recipient@unrelated.example" }],
      ccAddresses: [],
    });
    expect(alias).toBeNull();
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

  it("still trusts a Delivered-To header even when the Mail Account's own address has no parseable domain", () => {
    // The header tier never consults `ownDomain` at all (see this module's
    // own doc comment) — a garbled stored login address is this Mail
    // Account's problem elsewhere, not a reason to distrust an MDA's own
    // stamp of who actually received the message.
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: "not-an-address",
      headerBlock: headerBlock(["Delivered-To: sales@mycompany.com"]),
      toAddresses: [],
      ccAddresses: [],
    });
    expect(alias).toBe("sales@mycompany.com");
  });

  it("returns null for an account address with no parseable domain, once the To/Cc fallback is all there is", () => {
    const alias = resolveRecipientAlias({
      mailAccountEmailAddress: "not-an-address",
      headerBlock: undefined,
      toAddresses: [{ name: null, address: "sales@mycompany.com" }],
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
