import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildImageProxyPath,
  deriveImageProxyKey,
  fetchOnce,
  fetchProxiedImage,
  IMAGE_PROXY_TTL_MS,
  ImageProxyError,
  isPrivateOrReservedAddress,
  type ProxiedImage,
  type ResolvedAddress,
  resolveSafeAddress,
  rewriteRemoteImageReferences,
  verifyImageProxySignature,
} from "./image-proxy.js";

const KEY = deriveImageProxyKey("test-only-mail-credential-key-not-real-32b");

/** Pulls `sig` and `exp` off a path this module minted, the pair `verifyImageProxySignature` needs. */
function signedParams(path: string): { sig: string; exp: number } {
  const url = new URL(path, "http://localhost");
  return {
    sig: url.searchParams.get("sig") as string,
    exp: Number(url.searchParams.get("exp")),
  };
}

describe("sign/verify", () => {
  it("verifies a signature this module minted", () => {
    const path = buildImageProxyPath(KEY, "msg-1", "https://sender.example/x.png");
    const { sig, exp } = signedParams(path);
    expect(sig).toBeTruthy();
    expect(verifyImageProxySignature(KEY, "msg-1", "https://sender.example/x.png", sig, exp)).toBe(
      true,
    );
  });

  it("rejects a signature minted for a different message id", () => {
    expect(
      verifyImageProxySignature(
        KEY,
        "msg-2",
        "https://sender.example/x.png",
        "not-real",
        Date.now() + IMAGE_PROXY_TTL_MS,
      ),
    ).toBe(false);
  });

  it("rejects a tampered url even with the original signature", () => {
    const path = buildImageProxyPath(KEY, "msg-1", "https://sender.example/x.png");
    const { sig, exp } = signedParams(path);
    // Same signature, different target — the classic "point the proxy
    // somewhere new" tamper this HMAC exists to catch.
    expect(verifyImageProxySignature(KEY, "msg-1", "https://evil.example/x.png", sig, exp)).toBe(
      false,
    );
  });

  it("rejects a signature minted under a different key", () => {
    const otherKey = deriveImageProxyKey("a-completely-different-32-byte-secret!!");
    const path = buildImageProxyPath(otherKey, "msg-1", "https://sender.example/x.png");
    const { sig, exp } = signedParams(path);
    expect(verifyImageProxySignature(KEY, "msg-1", "https://sender.example/x.png", sig, exp)).toBe(
      false,
    );
  });

  it("rejects an expired signature even though the HMAC itself is genuine", () => {
    const now = Date.now();
    const path = buildImageProxyPath(KEY, "msg-1", "https://sender.example/x.png", now);
    const { sig, exp } = signedParams(path);
    expect(
      verifyImageProxySignature(
        KEY,
        "msg-1",
        "https://sender.example/x.png",
        sig,
        exp,
        exp + 1, // "now" arrives one ms after the URL's own expiry
      ),
    ).toBe(false);
  });

  it("accepts a signature right up to its own expiry", () => {
    const now = Date.now();
    const path = buildImageProxyPath(KEY, "msg-1", "https://sender.example/x.png", now);
    const { sig, exp } = signedParams(path);
    expect(
      verifyImageProxySignature(KEY, "msg-1", "https://sender.example/x.png", sig, exp, exp),
    ).toBe(true);
  });

  it("rejects a non-numeric or missing expiry outright, without touching the HMAC", () => {
    expect(
      verifyImageProxySignature(KEY, "msg-1", "https://sender.example/x.png", "anything", NaN),
    ).toBe(false);
  });
});

describe("rewriteRemoteImageReferences", () => {
  it("rewrites a remote <img src> to a signed same-origin path", () => {
    const out = rewriteRemoteImageReferences(`<img src="https://sender.example/t.gif">`, {
      messageId: "msg-1",
      key: KEY,
    });
    // The browser now requests our own path, never the sender's host
    // directly — the original URL only survives percent-encoded inside the
    // `url=` query param, which is the point (the proxy needs it to know
    // what to fetch server-side).
    expect(out).toContain('src="/messages/msg-1/image-proxy?url=');
    expect(out).not.toContain("https://sender.example");
  });

  it("rewrites a remote background-image url() the same way", () => {
    const out = rewriteRemoteImageReferences(
      `<div style="background:url(https://sender.example/bg.png)">x</div>`,
      { messageId: "msg-1", key: KEY },
    );
    expect(out).toContain("/messages/msg-1/image-proxy?url=");
    expect(out).not.toContain("https://sender.example");
  });

  it("leaves cid: and already-relative references alone", () => {
    const html = `<img src="cid:logo@example">`;
    expect(rewriteRemoteImageReferences(html, { messageId: "msg-1", key: KEY })).toBe(html);
  });

  it("mints a different signature per message id for the same url", () => {
    const a = rewriteRemoteImageReferences(`<img src="https://sender.example/t.gif">`, {
      messageId: "msg-1",
      key: KEY,
    });
    const b = rewriteRemoteImageReferences(`<img src="https://sender.example/t.gif">`, {
      messageId: "msg-2",
      key: KEY,
    });
    expect(a).not.toBe(b);
  });
});

describe("isPrivateOrReservedAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["::1", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["::ffff:127.0.0.1", true],
    ["2001:4860:4860::8888", false], // Google public DNS, v6
    ["not-an-ip", true], // refuse rather than guess
  ])("%s -> private=%s", (ip, expected) => {
    expect(isPrivateOrReservedAddress(ip)).toBe(expected);
  });
});

describe("resolveSafeAddress", () => {
  it("accepts a hostname that only resolves to public addresses", async () => {
    const resolved = await resolveSafeAddress("public.example", async () => [
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(resolved.address).toBe("8.8.8.8");
  });

  it("refuses a hostname that resolves to a private address", async () => {
    await expect(
      resolveSafeAddress("internal.example", async () => [{ address: "10.0.0.5", family: 4 }]),
    ).rejects.toThrow(ImageProxyError);
  });

  it("refuses if ANY candidate is private, even when another is public (rebinding shape)", async () => {
    const resolve = async (): Promise<ResolvedAddress[]> => [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(resolveSafeAddress("mixed.example", resolve)).rejects.toThrow(ImageProxyError);
  });

  it("validates an IP literal directly without calling the resolver", async () => {
    const resolve = async (): Promise<ResolvedAddress[]> => {
      throw new Error("should not be called for an IP literal");
    };
    await expect(resolveSafeAddress("127.0.0.1", resolve)).rejects.toThrow(ImageProxyError);
  });
});

describe("fetchProxiedImage", () => {
  it("rejects a non-http(s) scheme before ever resolving anything", async () => {
    await expect(fetchProxiedImage("file:///etc/passwd")).rejects.toMatchObject({
      code: "disallowed_scheme",
    });
  });

  it("rejects a malformed url", async () => {
    await expect(fetchProxiedImage("not a url")).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("refuses a loopback target end to end, even one this test process itself is serving", async () => {
    const server = createServer((_req, res) => res.end("nope"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(fetchProxiedImage(`http://127.0.0.1:${port}/x.png`)).rejects.toMatchObject({
        code: "disallowed_address",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * `resolveSafeAddress` refuses every loopback/private address by design —
 * correct in production, and unfalsifiable for the "does streaming actually
 * work" question in a sandboxed test run with no outbound internet. These
 * exercise `fetchOnce` directly instead: the same connection/redirect/size-
 * cap mechanics `fetchProxiedImage` calls after validation passes, against a
 * real local server, with the pinned address handed in exactly the way
 * `resolveSafeAddress` would after clearing a genuinely public target.
 */
describe("fetchOnce (streaming mechanics, address validation bypassed by construction)", () => {
  let server: Server | undefined;
  const LOOPBACK: ResolvedAddress = { address: "127.0.0.1", family: 4 };

  afterEach(async () => {
    if (server) await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  });

  async function listen(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  it("streams a small image's bytes and content-type through", async () => {
    const port = await listen((_req, res) => {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([1, 2, 3, 4]));
    });

    const result = await fetchOnce(new URL(`http://127.0.0.1:${port}/x.png`), LOOPBACK, {
      maxBytes: 1_000,
      timeoutMs: 1_000,
    });

    expect(result.kind).toBe("ok");
    const ok = result as ProxiedImage;
    expect(ok.contentType).toBe("image/png");
    expect([...ok.body]).toEqual([1, 2, 3, 4]);
  });

  it("reports a redirect instead of following it", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: "https://sender.example/final.png" });
      res.end();
    });

    const result = await fetchOnce(new URL(`http://127.0.0.1:${port}/x.png`), LOOPBACK, {
      maxBytes: 1_000,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ kind: "redirect", location: "https://sender.example/final.png" });
  });

  it("rejects a body past the byte cap instead of buffering it forever", async () => {
    const port = await listen((_req, res) => {
      res.end(Buffer.alloc(2_000, 1));
    });

    await expect(
      fetchOnce(new URL(`http://127.0.0.1:${port}/x.png`), LOOPBACK, {
        maxBytes: 100,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects a non-2xx upstream response", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });

    await expect(
      fetchOnce(new URL(`http://127.0.0.1:${port}/x.png`), LOOPBACK, {
        maxBytes: 1_000,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("times out against a server that never responds", async () => {
    const port = await listen(() => {
      // Never calls res.end() — the client has to be the one to give up.
    });

    await expect(
      fetchOnce(new URL(`http://127.0.0.1:${port}/x.png`), LOOPBACK, {
        maxBytes: 1_000,
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
