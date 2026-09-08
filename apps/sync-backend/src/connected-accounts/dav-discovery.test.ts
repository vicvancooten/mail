import { describe, expect, it, vi } from "vitest";
import { type DavDiscoveryDeps, discoverDavAccount } from "./dav-discovery.js";

/** A minimal multistatus body naming one property, in whatever "prefix" style a test wants to prove is tolerated. */
function multistatus(prefix: string, propXml: string): string {
  const p = prefix ? `${prefix}:` : "";
  return `<?xml version="1.0"?>
<${p}multistatus xmlns:${prefix || "D"}="DAV:">
  <${p}response>
    <${p}href>/</${p}href>
    <${p}propstat>
      <${p}prop>${propXml}</${p}prop>
      <${p}status>HTTP/1.1 200 OK</${p}status>
    </${p}propstat>
  </${p}response>
</${p}multistatus>`;
}

function principalBody(href: string, prefix = "D"): string {
  return multistatus(
    prefix,
    `<${prefix}:current-user-principal><${prefix}:href>${href}</${prefix}:href></${prefix}:current-user-principal>`,
  );
}

function calendarHomeSetBody(href: string, opts: { scheduling?: boolean } = {}): string {
  const scheduling = opts.scheduling
    ? `<C:schedule-inbox-URL><D:href>/sched/inbox/</D:href></C:schedule-inbox-URL>`
    : "";
  return multistatus(
    "D",
    `<C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"><D:href>${href}</D:href></C:calendar-home-set>${scheduling}`,
  );
}

function addressbookHomeSetBody(href: string): string {
  return multistatus(
    "D",
    `<CARD:addressbook-home-set xmlns:CARD="urn:ietf:params:xml:ns:carddav"><D:href>${href}</D:href></CARD:addressbook-home-set>`,
  );
}

function collectionsBody(
  entries: { href: string; type: "calendar" | "addressbook"; name?: string }[],
): string {
  const responses = entries
    .map(
      (entry) => `<D:response>
    <D:href>${entry.href}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:${entry.type}/></D:resourcetype>
        ${entry.name ? `<D:displayname>${entry.name}</D:displayname>` : ""}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
}

/** A `fetchImpl` stub keyed by exact URL, one response per call — `undefined` for an unhandled URL means "connection refused". */
function stubFetch(
  handlers: Record<
    string,
    () => { status: number; body?: string; location?: string } | "network-error"
  >,
) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const handler = handlers[url];
    if (!handler) {
      throw new Error(`unhandled fetch: ${url}`);
    }
    const result = handler();
    if (result === "network-error") {
      throw new Error("ECONNREFUSED");
    }
    return {
      status: result.status,
      text: async () => result.body ?? "",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location" ? (result.location ?? null) : null,
      },
    } as unknown as Response;
  });
}

function deps(
  fetchImpl: DavDiscoveryDeps["fetchImpl"],
  resolveSrv?: DavDiscoveryDeps["resolveSrv"],
): DavDiscoveryDeps {
  return {
    fetchImpl,
    resolveSrv: resolveSrv ?? vi.fn(async () => Promise.reject(new Error("no SRV record"))),
  };
}

describe("discoverDavAccount", () => {
  it("succeeds against the entered value directly, with no well-known or SRV calls", async () => {
    const fetchImpl = stubFetch({
      "https://dav.example.com/": () => ({
        status: 207,
        body: principalBody("/principals/alice/"),
      }),
      "https://dav.example.com/principals/alice/": () => ({
        status: 207,
        body: calendarHomeSetBody("/calendars/alice/"),
      }),
      "https://dav.example.com/calendars/alice/": () => ({
        status: 207,
        body: collectionsBody([{ href: "/calendars/alice/work/", type: "calendar", name: "Work" }]),
      }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "dav.example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result).toEqual({
      ok: true,
      principalUrl: "https://dav.example.com/principals/alice/",
      homeSetUrl: "https://dav.example.com/calendars/alice/",
      supportsScheduling: false,
      collections: { count: 1, names: ["Work"] },
    });
    // Only the three URLs above were ever registered as handlers — an
    // unhandled fetch throws, so this also proves well-known/SRV never ran.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("falls through to the well-known bootstrap when the entered value doesn't answer", async () => {
    const fetchImpl = stubFetch({
      "https://dav.example.com/": () => "network-error",
      "https://dav.example.com/.well-known/caldav": () => ({
        status: 301,
        location: "https://real.example.com/dav/",
      }),
      "https://real.example.com/dav/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://real.example.com/p/": () => ({ status: 207, body: calendarHomeSetBody("/hs/") }),
      "https://real.example.com/hs/": () => ({ status: 207, body: collectionsBody([]) }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "dav.example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.homeSetUrl).toBe("https://real.example.com/hs/");
  });

  it("falls through to a DNS SRV lookup when the entered value and well-known both miss", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => "network-error",
      "https://example.com/.well-known/caldav": () => "network-error",
      "https://srv.example.com:8443/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://srv.example.com:8443/p/": () => ({ status: 207, body: calendarHomeSetBody("/hs/") }),
      "https://srv.example.com:8443/hs/": () => ({ status: 207, body: collectionsBody([]) }),
    });
    const resolveSrv = vi.fn(async () => [
      { name: "srv.example.com", port: 8443, priority: 0, weight: 0 },
    ]);

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl, resolveSrv),
    );

    expect(result.ok).toBe(true);
    expect(resolveSrv).toHaveBeenCalledWith("_caldavs._tcp.example.com");
  });

  it("reports unreachable when every candidate misses", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => "network-error",
      "https://example.com/.well-known/caldav": () => "network-error",
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("reports credentials_rejected and stops at the first host that answers 401, never trying the next candidate", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => ({ status: 401 }),
    });

    const result = await discoverDavAccount(
      { serverAddress: "example.com", username: "alice", password: "wrong", facet: "calendar" },
      deps(fetchImpl),
    );

    expect(result).toEqual({ ok: false, reason: "credentials_rejected" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports no_home_set when a real server answers but has nothing for this facet", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://example.com/p/": () => ({ status: 207, body: multistatus("D", "") }), // no calendar-home-set property
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result).toEqual({ ok: false, reason: "no_home_set" });
  });

  it("resolves the known-host table for iCloud without touching well-known or SRV", async () => {
    const fetchImpl = stubFetch({
      "https://caldav.icloud.com/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://caldav.icloud.com/p/": () => ({ status: 207, body: calendarHomeSetBody("/hs/") }),
      "https://caldav.icloud.com/hs/": () => ({ status: 207, body: collectionsBody([]) }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@icloud.com",
        username: "alice@icloud.com",
        password: "app-specific",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("resolves iCloud's Contacts Facet to a different fixed host than Calendar", async () => {
    const fetchImpl = stubFetch({
      "https://contacts.icloud.com/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://contacts.icloud.com/p/": () => ({
        status: 207,
        body: addressbookHomeSetBody("/hs/"),
      }),
      "https://contacts.icloud.com/hs/": () => ({ status: 207, body: collectionsBody([]) }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@icloud.com",
        username: "alice@icloud.com",
        password: "app-specific",
        facet: "contacts",
      },
      deps(fetchImpl),
    );

    expect(result.ok).toBe(true);
  });

  it("detects RFC 6638 scheduling support for a calendar Facet", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://example.com/p/": () => ({
        status: 207,
        body: calendarHomeSetBody("/hs/", { scheduling: true }),
      }),
      "https://example.com/hs/": () => ({ status: 207, body: collectionsBody([]) }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result.ok && result.supportsScheduling).toBe(true);
  });

  it("never reports scheduling support for a contacts Facet", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://example.com/p/": () => ({ status: 207, body: addressbookHomeSetBody("/hs/") }),
      "https://example.com/hs/": () => ({ status: 207, body: collectionsBody([]) }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@example.com",
        username: "alice",
        password: "secret",
        facet: "contacts",
      },
      deps(fetchImpl),
    );

    expect(result.ok && result.supportsScheduling).toBe(false);
  });

  it("counts and names discovered collections, skipping the home-set collection itself", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => ({ status: 207, body: principalBody("/p/") }),
      "https://example.com/p/": () => ({ status: 207, body: calendarHomeSetBody("/hs/") }),
      "https://example.com/hs/": () => ({
        status: 207,
        body: collectionsBody([
          { href: "/hs/", type: "calendar" }, // the home-set collection itself
          { href: "/hs/work/", type: "calendar", name: "Work" },
          { href: "/hs/home/", type: "calendar", name: "Home" },
          { href: "/hs/notes/", type: "addressbook", name: "Not a calendar" },
        ]),
      }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result.ok && result.collections).toEqual({ count: 2, names: ["Work", "Home"] });
  });

  it("tolerates a server that answers without a namespace prefix", async () => {
    const fetchImpl = stubFetch({
      "https://example.com/": () => ({ status: 207, body: principalBody("/p/", "") }),
      "https://example.com/p/": () => ({ status: 207, body: calendarHomeSetBody("/hs/") }),
      "https://example.com/hs/": () => ({ status: 207, body: collectionsBody([]) }),
    });

    const result = await discoverDavAccount(
      {
        serverAddress: "alice@example.com",
        username: "alice",
        password: "secret",
        facet: "calendar",
      },
      deps(fetchImpl),
    );

    expect(result.ok).toBe(true);
  });
});
