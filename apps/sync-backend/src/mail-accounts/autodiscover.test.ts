import { describe, expect, it, vi } from "vitest";
import type { AutodiscoverDeps } from "./autodiscover.js";
import { discoverMailAccount } from "./autodiscover.js";

const CONFIG_XML = (host: string) => `<clientConfig version="1.1">
  <emailProvider id="example.com">
    <domain>example.com</domain>
    <incomingServer type="imap">
      <hostname>imap.${host}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.${host}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

function jsonResponse(body: string, ok = true): Response {
  return { ok, text: () => Promise.resolve(body) } as Response;
}

function notFoundResponse(): Response {
  return { ok: false, text: () => Promise.resolve("") } as Response;
}

function makeDeps(overrides: Partial<AutodiscoverDeps> = {}): AutodiscoverDeps {
  return {
    fetchImpl: vi.fn().mockResolvedValue(notFoundResponse()),
    resolveSrv: vi.fn().mockRejectedValue(new Error("ENODATA")),
    resolveMx: vi.fn().mockRejectedValue(new Error("ENODATA")),
    ...overrides,
  };
}

describe("discoverMailAccount", () => {
  it("succeeds from the autoconfig.<domain> step (domain that publishes config)", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn((url: string) => {
        if (String(url).includes("autoconfig.example.com")) {
          return Promise.resolve(jsonResponse(CONFIG_XML("example.com")));
        }
        return Promise.resolve(notFoundResponse());
      }) as unknown as typeof fetch,
    });

    const result = await discoverMailAccount("vic@example.com", deps);
    expect(result).toEqual({
      found: true,
      source: "autoconfig",
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
    });
  });

  it("falls back to .well-known/autoconfig when the autoconfig subdomain has nothing", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn((url: string) => {
        if (String(url).includes("/.well-known/autoconfig/")) {
          return Promise.resolve(jsonResponse(CONFIG_XML("example.com")));
        }
        return Promise.resolve(notFoundResponse());
      }) as unknown as typeof fetch,
    });

    const result = await discoverMailAccount("vic@example.com", deps);
    expect(result).toMatchObject({ found: true, source: "well-known" });
  });

  it("falls back to RFC 6186 SRV when nothing HTTP-based is published", async () => {
    const deps = makeDeps({
      resolveSrv: vi.fn((name: string) => {
        if (name === "_imaps._tcp.example.com") {
          return Promise.resolve([{ name: "imap.example.com", port: 993, priority: 0, weight: 0 }]);
        }
        if (name === "_submission._tcp.example.com") {
          return Promise.resolve([{ name: "smtp.example.com", port: 587, priority: 0, weight: 0 }]);
        }
        return Promise.reject(new Error("ENODATA"));
      }) as unknown as typeof import("node:dns/promises").resolveSrv,
    });

    const result = await discoverMailAccount("vic@example.com", deps);
    expect(result).toEqual({
      found: true,
      source: "srv",
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
    });
  });

  it("respects an explicitly-absent SRV target (RFC 6186 '.')", async () => {
    const deps = makeDeps({
      resolveSrv: vi.fn((name: string) => {
        if (name === "_imaps._tcp.example.com") {
          return Promise.resolve([{ name: ".", port: 0, priority: 0, weight: 0 }]);
        }
        return Promise.reject(new Error("ENODATA"));
      }) as unknown as typeof import("node:dns/promises").resolveSrv,
    });

    const result = await discoverMailAccount("vic@example.com", deps);
    expect(result.found).toBe(false);
  });

  it("falls back to the Mozilla ISPDB", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn((url: string) => {
        if (String(url).startsWith("https://autoconfig.thunderbird.net/")) {
          return Promise.resolve(jsonResponse(CONFIG_XML("example.com")));
        }
        return Promise.resolve(notFoundResponse());
      }) as unknown as typeof fetch,
    });

    const result = await discoverMailAccount("vic@example.com", deps);
    expect(result).toMatchObject({ found: true, source: "ispdb" });
  });

  it("prefills privateemail defaults when nothing is found but MX matches mx1/mx2.privateemail.com", async () => {
    const deps = makeDeps({
      resolveMx: vi.fn().mockResolvedValue([
        { exchange: "mx1.privateemail.com", priority: 10 },
        { exchange: "mx2.privateemail.com", priority: 10 },
      ]) as unknown as typeof import("node:dns/promises").resolveMx,
    });

    const result = await discoverMailAccount("vic@example.com", deps);
    expect(result).toEqual({
      found: false,
      prefill: {
        imap: { host: "mail.privateemail.com", port: 993, security: "tls" },
        smtp: { host: "mail.privateemail.com", port: 587, security: "starttls" },
      },
    });
  });

  it("manual fallback has no prefill when MX doesn't match privateemail", async () => {
    const deps = makeDeps({
      resolveMx: vi
        .fn()
        .mockResolvedValue([
          { exchange: "aspmx.l.google.com", priority: 10 },
        ]) as unknown as typeof import("node:dns/promises").resolveMx,
    });

    const result = await discoverMailAccount("vic@example.com", deps);
    expect(result).toEqual({ found: false, prefill: null });
  });
});
