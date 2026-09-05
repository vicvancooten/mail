import { describe, expect, it } from "vitest";
import { mailAccounts } from "../db/schema.js";
import { createTestMailAccount } from "./mail-account.js";

describe("createTestMailAccount", () => {
  it("seeds Microsoft oauth credentials with Microsoft scopes", async () => {
    let insertedMailAccount: Record<string, unknown> | undefined;
    const db = {
      insert(table: unknown) {
        expect(table).toBe(mailAccounts);
        return {
          values(values: Record<string, unknown>) {
            insertedMailAccount = values;
            return {
              async returning() {
                return [values];
              },
            };
          },
        };
      },
    };

    const account = await createTestMailAccount(db as never, {
      userId: "user-1",
      oauth: { provider: "microsoft", accessToken: "access-token" },
    });

    expect(insertedMailAccount).toBeDefined();
    expect(account.credential.kind).toBe("oauth");
    if (account.credential.kind !== "oauth") {
      throw new Error("expected oauth credential");
    }
    expect(account.credential.provider).toBe("microsoft");
    expect(account.credential.scope).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(account.credential.scope).toContain("https://outlook.office.com/SMTP.Send");
    expect(account.credential.scope).not.toContain("https://mail.google.com/");
  });
});
