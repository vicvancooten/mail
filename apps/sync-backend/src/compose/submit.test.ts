import type { ComposeDocument } from "@mail/shared";
import type Mail from "nodemailer/lib/mailer/index.js";
import { describe, expect, it } from "vitest";
import type { CompositionRow } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { buildMime } from "./draft-mime.js";
import { classifyFailure, submitComposition } from "./submit.js";

/**
 * Submission's two decisions that do not need a mail server to test: what
 * goes on the wire versus what goes into `Sent`, and how a mail server's
 * "no" is classified (ADR-0007's three-way split). The SMTP conversation
 * itself is `send.greenmail.test.ts`'s.
 */

const DOC: ComposeDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body text." }] }],
};

const ACCOUNT = {
  id: "acct-1",
  emailAddress: "vic@example.test",
  smtpHost: "smtp.example.test",
  smtpPort: 587,
  smtpSecurity: "starttls",
  username: "vic@example.test",
  credential: { kind: "password", ciphertext: "", iv: "", tag: "" },
} as unknown as MailAccountRow;

const ROW = {
  id: "comp-1",
  mailAccountId: "acct-1",
  status: "submitting",
  subject: "Lunch",
  document: DOC,
  toAddresses: [{ name: "Ada", address: "ada@example.test" }],
  ccAddresses: [{ name: null, address: "cc@example.test" }],
  bccAddresses: [{ name: null, address: "hidden@example.test" }],
  messageId: "minted-id@example.test",
  imapDraftUid: null,
  sendAttempts: 1,
} as unknown as CompositionRow;

const NOW = new Date("2026-09-01T12:00:00.000Z");

async function captureSubmission(row: CompositionRow = ROW) {
  const sent: Mail.Options[] = [];
  const result = await submitComposition(ACCOUNT, row, {
    credentialKey: Buffer.alloc(32),
    sendMail: async (options) => {
      sent.push(options);
    },
    now: NOW,
  });
  return { result, transmitted: sent[0] };
}

describe("submitComposition", () => {
  it("strips Bcc from the transmitted headers but carries every Bcc address in the envelope", async () => {
    const { result, transmitted } = await captureSubmission();

    expect(result.ok).toBe(true);
    expect(transmitted?.bcc).toBeUndefined();
    // compose-spec: "one envelope recipient per address" — To, Cc and Bcc all.
    expect(transmitted?.envelope).toEqual({
      from: "vic@example.test",
      to: ["ada@example.test", "cc@example.test", "hidden@example.test"],
    });

    const wire = (await buildMime(transmitted ?? {})).toString("utf8");
    expect(wire).not.toContain("hidden@example.test");
    expect(wire).toContain("ada@example.test");
  });

  it("keeps Bcc in the Sent copy, so the User can see who they Bcc'd", async () => {
    const { result } = await captureSubmission();
    if (!result.ok) throw new Error("expected a successful submission");

    const sentCopy = result.mime.toString("utf8");
    expect(sentCopy).toContain("hidden@example.test");
    expect(sentCopy).toMatch(/^Bcc:/m);
  });

  it("carries the Sync Backend's minted Message-ID identically on the wire and in Sent", async () => {
    const { result, transmitted } = await captureSubmission();
    if (!result.ok) throw new Error("expected a successful submission");

    const wire = (await buildMime(transmitted ?? {})).toString("utf8");
    expect(wire).toContain("<minted-id@example.test>");
    expect(result.mime.toString("utf8")).toContain("<minted-id@example.test>");
  });

  it("pins one Date across both copies, so Sent is the message that was sent", async () => {
    const { result, transmitted } = await captureSubmission();
    if (!result.ok) throw new Error("expected a successful submission");

    const wire = (await buildMime(transmitted ?? {})).toString("utf8");
    const dateLine = /^Date: (.+)$/m;
    expect(wire.match(dateLine)?.[1]).toBe(result.mime.toString("utf8").match(dateLine)?.[1]);
  });

  it("is always multipart/alternative, even for an unformatted document (ADR-0013)", async () => {
    const { result } = await captureSubmission();
    if (!result.ok) throw new Error("expected a successful submission");
    expect(result.mime.toString("utf8")).toMatch(/Content-Type:\s*multipart\/alternative/i);
  });

  it("refuses a message with no recipient rather than opening an SMTP connection", async () => {
    const naked = { ...ROW, toAddresses: [], ccAddresses: [], bccAddresses: [] } as CompositionRow;
    const sent: Mail.Options[] = [];
    const result = await submitComposition(ACCOUNT, naked, {
      credentialKey: Buffer.alloc(32),
      sendMail: async (options) => {
        sent.push(options);
      },
    });
    expect(result).toEqual({
      ok: false,
      kind: "permanent",
      detail: "No recipients on this message.",
    });
    expect(sent).toEqual([]);
  });

  it("classifies whatever the transport threw", async () => {
    const result = await submitComposition(ACCOUNT, ROW, {
      credentialKey: Buffer.alloc(32),
      sendMail: async () => {
        throw Object.assign(new Error("Message failed"), {
          responseCode: 550,
          response: "550 5.7.1 relay denied",
        });
      },
    });
    expect(result).toEqual({ ok: false, kind: "permanent", detail: "550 5.7.1 relay denied" });
  });
});

describe("classifyFailure", () => {
  it("reads a 5xx reply as permanent and shows the server's own line verbatim", () => {
    expect(
      classifyFailure(
        Object.assign(new Error("Message failed"), {
          responseCode: 550,
          response: "550 5.7.1 relay denied",
        }),
      ),
    ).toEqual({ kind: "permanent", detail: "550 5.7.1 relay denied" });
  });

  it("reads a 4xx reply as transient", () => {
    expect(
      classifyFailure(
        Object.assign(new Error("Message failed"), {
          responseCode: 451,
          response: "451 4.3.0 try again later",
        }),
      ),
    ).toEqual({ kind: "transient", detail: "451 4.3.0 try again later" });
  });

  it("reads EAUTH as Needs Reauth — the credential's problem, not this message's", () => {
    expect(classifyFailure(Object.assign(new Error("Invalid login"), { code: "EAUTH" }))).toEqual({
      kind: "reauth",
      detail: "Invalid login",
    });
  });

  it("treats a connection-level failure as transient: the server never rejected the mail", () => {
    expect(
      classifyFailure(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" })),
    ).toEqual({ kind: "transient", detail: "connect ECONNREFUSED" });
  });

  it("falls back to the error message when there is no SMTP reply line to quote", () => {
    expect(classifyFailure(new Error("socket hang up"))).toEqual({
      kind: "transient",
      detail: "socket hang up",
    });
  });
});
