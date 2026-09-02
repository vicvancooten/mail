import type { MessageStructureObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { hasRealAttachments, readBodyParts } from "./body-structure.js";

/** A single-part `text/plain` message: ImapFlow leaves `part` undefined on the root. */
const SINGLE_PART: MessageStructureObject = { type: "text/plain", size: 120 };

const ALTERNATIVE_WITH_ATTACHMENT: MessageStructureObject = {
  type: "multipart/mixed",
  childNodes: [
    {
      part: "1",
      type: "multipart/alternative",
      childNodes: [
        { part: "1.1", type: "text/plain", size: 200 },
        { part: "1.2", type: "text/html", size: 900 },
      ],
    },
    {
      part: "2",
      type: "application/pdf",
      size: 51_200,
      disposition: "attachment",
      dispositionParameters: { filename: "invoice.pdf" },
      encoding: "BASE64",
    },
    {
      part: "3",
      type: "image/png",
      size: 4_096,
      disposition: "inline",
      id: "<logo@example.test>",
    },
  ],
};

describe("readBodyParts", () => {
  it("addresses a single-part body as part 1, per RFC 3501", () => {
    expect(readBodyParts(SINGLE_PART)).toEqual({
      textPart: "1",
      htmlPart: null,
      attachments: [],
    });
  });

  it("finds both alternatives and lists everything else as an attachment", () => {
    const parts = readBodyParts(ALTERNATIVE_WITH_ATTACHMENT);

    expect(parts.textPart).toBe("1.1");
    expect(parts.htmlPart).toBe("1.2");
    expect(parts.attachments).toEqual([
      {
        part: "2",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 51_200,
        contentId: null,
        inline: false,
        // Lowercased from BODYSTRUCTURE's "BASE64" — the fetch-through
        // download decodes against this value (`routes/messages.ts`).
        encoding: "base64",
      },
      {
        part: "3",
        filename: null,
        mimeType: "image/png",
        sizeBytes: 4_096,
        // Brackets off, per RFC 2392, so a `cid:` href matches it directly.
        contentId: "logo@example.test",
        inline: true,
        // No encoding declared on this fixture node — falls back to null
        // rather than throwing, since a caller decodes 7bit/8bit as-is.
        encoding: null,
      },
    ]);
  });

  it("treats a text part with a filename as an attachment, not the body", () => {
    const parts = readBodyParts({
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", size: 10 },
        {
          part: "2",
          type: "text/plain",
          size: 40,
          disposition: "attachment",
          dispositionParameters: { filename: "notes.txt" },
        },
      ],
    });

    expect(parts.textPart).toBe("1");
    expect(parts.attachments.map((a) => a.filename)).toEqual(["notes.txt"]);
  });

  it("has nothing to say about a message with no structure yet", () => {
    expect(readBodyParts(undefined)).toEqual({ textPart: null, htmlPart: null, attachments: [] });
  });
});

describe("hasRealAttachments", () => {
  it("ignores an embedded image that only exists for a `cid:` reference", () => {
    const parts = readBodyParts(ALTERNATIVE_WITH_ATTACHMENT);
    const embeddedOnly = parts.attachments.filter((a) => a.contentId !== null);

    expect(hasRealAttachments(embeddedOnly)).toBe(false);
    expect(hasRealAttachments(parts.attachments)).toBe(true);
  });
});
