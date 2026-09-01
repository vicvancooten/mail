import type { MessageAttachment } from "@mail/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeCidReference,
  findCidReferences,
  isRealAttachment,
  realAttachments,
  resolveCidBlobs,
  revokeCidBlobs,
} from "./cid.js";

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    part: "2",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 10,
    contentId: null,
    inline: false,
    ...overrides,
  };
}

describe("findCidReferences", () => {
  it("finds a cid: reference in an <img src>", () => {
    expect(findCidReferences(`<img src="cid:logo@example">`)).toEqual(["logo@example"]);
  });

  it("finds a cid: reference inside a CSS url()", () => {
    expect(findCidReferences(`<style>.a{background:url(cid:banner@example)}</style>`)).toEqual([
      "banner@example",
    ]);
  });

  it("percent-decodes per RFC 2392's own worked example", () => {
    expect(findCidReferences(`<img src="cid:foo4%25foo1@bar.net">`)).toEqual(["foo4%foo1@bar.net"]);
  });

  it("de-duplicates repeated references", () => {
    expect(findCidReferences(`<img src="cid:logo@example"><img src="cid:logo@example">`)).toEqual([
      "logo@example",
    ]);
  });

  it("finds nothing in a body with no cid: references", () => {
    expect(findCidReferences(`<p>hello</p><img src="https://a.example/x.png">`)).toEqual([]);
  });
});

describe("decodeCidReference", () => {
  it("strips the cid: prefix and percent-decodes", () => {
    expect(decodeCidReference("cid:foo4%25foo1@bar.net")).toBe("foo4%foo1@bar.net");
  });
});

describe("resolveCidBlobs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches only the attachments a contentId actually matches, and builds blob: URLs", async () => {
    const blob = new Blob(["logo-bytes"]);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:http://localhost/abc") });

    const attachments = [attachment({ part: "3", contentId: "logo@example" })];
    const result = await resolveCidBlobs("msg-1", ["logo@example"], attachments);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/messages/msg-1/attachments/3",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(result).toEqual([{ contentId: "logo@example", blobUrl: "blob:http://localhost/abc" }]);
  });

  it("skips a contentId with no matching attachment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveCidBlobs("msg-1", ["missing@example"], []);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("omits (never throws for) a fetch that comes back non-ok or rejects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const attachments = [
      attachment({ part: "3", contentId: "a@example" }),
      attachment({ part: "4", contentId: "b@example" }),
    ];
    const result = await resolveCidBlobs("msg-1", ["a@example", "b@example"], attachments);

    expect(result).toEqual([]);
  });
});

describe("revokeCidBlobs", () => {
  it("revokes every blob URL passed in", () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { ...URL, revokeObjectURL: revoke });

    revokeCidBlobs([
      { contentId: "a", blobUrl: "blob:1" },
      { contentId: "b", blobUrl: "blob:2" },
    ]);

    expect(revoke).toHaveBeenCalledWith("blob:1");
    expect(revoke).toHaveBeenCalledWith("blob:2");
    vi.unstubAllGlobals();
  });
});

describe("isRealAttachment / realAttachments", () => {
  it("counts a cid:-only inline part as not real", () => {
    expect(isRealAttachment(attachment({ inline: true, contentId: "logo@example" }))).toBe(false);
  });

  it("counts an inline part with no Content-ID as real (a User dropped a file inline)", () => {
    expect(isRealAttachment(attachment({ inline: true, contentId: null }))).toBe(true);
  });

  it("counts a non-inline attachment as real regardless of Content-ID", () => {
    expect(isRealAttachment(attachment({ inline: false, contentId: "x@example" }))).toBe(true);
  });

  it("filters a message's attachments down to only the real ones", () => {
    const message = {
      attachments: [
        attachment({ part: "2", inline: false, contentId: null }),
        attachment({ part: "3", inline: true, contentId: "logo@example" }),
      ],
    };
    expect(realAttachments(message).map((a) => a.part)).toEqual(["2"]);
  });
});
