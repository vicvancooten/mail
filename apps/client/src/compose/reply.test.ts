import type { MailAccount, Message } from "@mail/shared";
import { describe, expect, it } from "vitest";
import {
  buildReplyContent,
  buildReplyDocument,
  buildReplyRecipients,
  buildSubject,
  buildThreadingHeaders,
  truncateReferences,
} from "./reply.js";

function makeAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: "acct-1",
    emailAddress: "vic@example.test",
    imap: { host: "imap.example.test", port: 993, security: "tls" },
    smtp: { host: "smtp.example.test", port: 587, security: "starttls" },
    status: "active",
    sync: { state: "idle", lastProgressAt: null, lastError: null },
    indexWatermark: { coveredSince: null, complete: false },
    signature: null,
    notificationsEnabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    threadId: "thread-1",
    mailAccountId: "acct-1",
    messageIdHeader: "original@example.test",
    references: ["root@example.test"],
    subject: "Lunch plans",
    from: { name: "Ada Lovelace", address: "ada@example.test" },
    to: [{ name: "Vic", address: "vic@example.test" }],
    cc: [{ name: "Bob", address: "bob@example.test" }],
    replyTo: [],
    sentAt: "2026-06-01T12:00:00.000Z",
    receivedAt: "2026-06-01T12:00:00.000Z",
    seen: true,
    flagged: false,
    attachments: [],
    bodyText: "See you at noon.",
    bodyHtml: "<p>See you at noon.</p>",
    ...overrides,
  };
}

describe("truncateReferences (#47, compose-spec §Threading headers)", () => {
  it("keeps a short chain intact", () => {
    const chain = ["a", "b", "c"];
    expect(truncateReferences(chain)).toEqual(chain);
  });

  it("keeps the first and last ~20, dropping the middle, once the chain is long", () => {
    const chain = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    const result = truncateReferences(chain);
    expect(result).toHaveLength(40);
    expect(result.slice(0, 20)).toEqual(chain.slice(0, 20));
    expect(result.slice(20)).toEqual(chain.slice(30));
  });
});

describe("buildThreadingHeaders", () => {
  it("In-Reply-To is the open message's Message-ID; References is its chain plus that id", () => {
    const message = makeMessage();
    expect(buildThreadingHeaders(message)).toEqual({
      inReplyTo: "original@example.test",
      references: ["root@example.test", "original@example.test"],
    });
  });

  it("is empty for a message with no Message-ID of its own", () => {
    const message = makeMessage({ messageIdHeader: null });
    expect(buildThreadingHeaders(message)).toEqual({ inReplyTo: null, references: [] });
  });
});

describe("buildSubject", () => {
  it("prefixes Re: for a reply", () => {
    expect(buildSubject("Lunch plans", "reply")).toBe("Re: Lunch plans");
    expect(buildSubject("Lunch plans", "replyAll")).toBe("Re: Lunch plans");
  });

  it("prefixes Fwd: for a forward", () => {
    expect(buildSubject("Lunch plans", "forward")).toBe("Fwd: Lunch plans");
  });

  it("never stacks a prefix already present", () => {
    expect(buildSubject("Re: Lunch plans", "reply")).toBe("Re: Lunch plans");
    expect(buildSubject("re: Lunch plans", "reply")).toBe("re: Lunch plans");
    expect(buildSubject("Fwd: Lunch plans", "forward")).toBe("Fwd: Lunch plans");
  });
});

describe("buildReplyRecipients (#47, compose-spec §Recipients)", () => {
  it("reply: To is the original's From when there is no Reply-To", () => {
    const { to, cc } = buildReplyRecipients("reply", makeMessage(), makeAccount());
    expect(to).toEqual([{ name: "Ada Lovelace", address: "ada@example.test" }]);
    expect(cc).toEqual([]);
  });

  it("reply: To is the original's Reply-To when present, not From", () => {
    const message = makeMessage({ replyTo: [{ name: "List", address: "list@example.test" }] });
    const { to } = buildReplyRecipients("reply", message, makeAccount());
    expect(to).toEqual([{ name: "List", address: "list@example.test" }]);
  });

  it("reply-all: adds the original To/Cc as Cc, minus the sending account's own address", () => {
    const message = makeMessage({
      to: [
        { name: "Vic", address: "vic@example.test" }, // the sending account itself
        { name: "Carol", address: "carol@example.test" },
      ],
      cc: [{ name: "Bob", address: "bob@example.test" }],
    });
    const { to, cc } = buildReplyRecipients("replyAll", message, makeAccount());
    expect(to).toEqual([{ name: "Ada Lovelace", address: "ada@example.test" }]);
    expect(cc).toEqual([
      { name: "Carol", address: "carol@example.test" },
      { name: "Bob", address: "bob@example.test" },
    ]);
  });

  it("reply-all deduplicates on normalized address, keeping the best display name seen", () => {
    const message = makeMessage({
      from: { name: null, address: "Ada@Example.test" },
      to: [{ name: "Vic", address: "vic@example.test" }],
      cc: [{ name: "Ada Lovelace", address: "ada@example.test" }],
    });
    const { to, cc } = buildReplyRecipients("replyAll", message, makeAccount());
    expect(to).toEqual([{ name: null, address: "Ada@Example.test" }]);
    // Ada also appears in Cc with a name — but she's already in To, so she is
    // not duplicated into Cc too.
    expect(cc).toEqual([]);
  });

  it("forward starts with empty recipients — the User picks new ones", () => {
    expect(buildReplyRecipients("forward", makeMessage(), makeAccount())).toEqual({
      to: [],
      cc: [],
    });
  });
});

describe("buildReplyDocument (#47, ADR-0013)", () => {
  it("carries the original bodyHtml into the mailQuote node byte-identically", () => {
    const message = makeMessage({ bodyHtml: '<p>Weird &amp; <b>bold</b> "quoted"</p>' });
    const doc = buildReplyDocument("reply", message, null);
    const quote = doc.content.find((node) => node.type === "mailQuote");
    expect(quote?.attrs?.html).toBe('<p>Weird &amp; <b>bold</b> "quoted"</p>');
  });

  it("puts the signature above the quote, as a distinct node, when one is set", () => {
    const doc = buildReplyDocument("reply", makeMessage(), "Ada\nComputing pioneer");
    expect(doc.content[0]?.type).toBe("mailSignature");
    expect(doc.content.at(-1)?.type).toBe("mailQuote");
  });

  it("omits the signature node entirely when there is none", () => {
    const doc = buildReplyDocument("reply", makeMessage(), null);
    expect(doc.content.some((node) => node.type === "mailSignature")).toBe(false);
  });

  it("a forward carries the conventional forwarded-message header block", () => {
    const doc = buildReplyDocument("forward", makeMessage(), null);
    const text = (node: { content?: { text?: string }[] }) =>
      node.content?.map((child) => child.text ?? "").join("") ?? "";
    expect(text(doc.content[1] ?? {})).toBe("---------- Forwarded message ---------");
    expect(text(doc.content[2] ?? {})).toContain("From: Ada Lovelace <ada@example.test>");
    expect(text(doc.content[3] ?? {})).toContain("Date:");
    expect(text(doc.content[4] ?? {})).toContain("Subject: Lunch plans");
  });
});

describe("buildReplyContent", () => {
  it("assembles subject, recipients, threading headers and document together", () => {
    const content = buildReplyContent("reply", makeMessage(), makeAccount());
    expect(content.subject).toBe("Re: Lunch plans");
    expect(content.to).toEqual([{ name: "Ada Lovelace", address: "ada@example.test" }]);
    expect(content.inReplyTo).toBe("original@example.test");
    expect(content.references).toEqual(["root@example.test", "original@example.test"]);
  });

  it("a forward has no threading headers — it starts a new thread", () => {
    const content = buildReplyContent("forward", makeMessage(), makeAccount());
    expect(content.inReplyTo).toBeNull();
    expect(content.references).toEqual([]);
  });
});
