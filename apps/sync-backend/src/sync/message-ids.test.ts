import { describe, expect, it } from "vitest";
import {
  extractReferencesHeader,
  normalizeMessageId,
  parseReferences,
  threadingIdsFor,
} from "./message-ids.js";
import { baseSubject } from "./subject.js";

describe("normalizeMessageId", () => {
  it("strips brackets and surrounding whitespace", () => {
    expect(normalizeMessageId("  <abc@example.test>  ")).toBe("abc@example.test");
  });

  it("preserves case, because an id's local part is case-sensitive", () => {
    expect(normalizeMessageId("<AbC@Example.Test>")).toBe("AbC@Example.Test");
  });

  it("rejects anything that cannot identify a message", () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("<>")).toBeNull();
    expect(normalizeMessageId("no-at-sign")).toBeNull();
    expect(normalizeMessageId("<a b@example.test>")).toBeNull();
    expect(normalizeMessageId(`<${"x".repeat(1200)}@example.test>`)).toBeNull();
  });
});

describe("parseReferences", () => {
  it("reads a folded, comma-littered chain oldest-first without duplicates", () => {
    const chain = parseReferences("<a@x.test>,\r\n <b@x.test> <a@x.test>\t<c@x.test>");
    expect(chain).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
  });

  it("falls back to whitespace splitting when a client omits the brackets", () => {
    expect(parseReferences("a@x.test b@x.test")).toEqual(["a@x.test", "b@x.test"]);
  });

  it("caps a pathological chain", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `<m${i}@x.test>`).join(" ");
    expect(parseReferences(huge)).toHaveLength(100);
  });
});

describe("extractReferencesHeader", () => {
  it("unfolds the header block ImapFlow returns", () => {
    const block = Buffer.from("References: <a@x.test>\r\n <b@x.test>\r\n\r\n", "utf8");
    expect(extractReferencesHeader(block)).toEqual(["a@x.test", "b@x.test"]);
  });

  it("is empty when the header is absent", () => {
    expect(extractReferencesHeader(Buffer.from("\r\n"))).toEqual([]);
    expect(extractReferencesHeader(undefined)).toEqual([]);
  });
});

describe("threadingIdsFor", () => {
  it("puts ancestors first and the message's own id last", () => {
    expect(
      threadingIdsFor({
        messageId: "c@x.test",
        inReplyTo: "b@x.test",
        references: ["a@x.test", "b@x.test"],
      }),
    ).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
  });

  it("survives a message with no id of its own", () => {
    expect(threadingIdsFor({ messageId: null, inReplyTo: "b@x.test", references: [] })).toEqual([
      "b@x.test",
    ]);
  });
});

describe("baseSubject", () => {
  it("strips stacked reply and forward prefixes in both languages", () => {
    expect(baseSubject("Re: Fwd: RE: Quarterly numbers")).toBe("Quarterly numbers");
    expect(baseSubject("Antw: Doorst: Kwartaalcijfers")).toBe("Kwartaalcijfers");
    expect(baseSubject("Re[2]: Quarterly numbers")).toBe("Quarterly numbers");
  });

  it("strips a leading mailing-list tag", () => {
    expect(baseSubject("[pgsql-hackers] Re: vacuum")).toBe("vacuum");
  });

  it("leaves an ordinary subject alone", () => {
    expect(baseSubject("Recipe for pancakes")).toBe("Recipe for pancakes");
    expect(baseSubject(null)).toBe("");
  });
});
