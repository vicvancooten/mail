import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGooglePeopleClient,
  GoogleContactWriteRejectedError,
  GoogleSyncTokenExpiredError,
} from "./client.js";

/**
 * The real Google People API client (#214) — the wire format alone, the
 * same division `google-adapter.test.ts` draws for the OAuth adapter:
 * `people-sync.test.ts` drives the sync engine through a fake
 * `GooglePeopleClient`, this file's whole job is "what goes out on the
 * request and what a response maps to".
 */

function mockPeopleApi(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listConnections", () => {
  it("sends the bearer token, personFields mask and paging/sync params", async () => {
    const fetchMock = mockPeopleApi(200, { connections: [], nextSyncToken: "token-1" });
    const client = createGooglePeopleClient();

    await client.listConnections("access-token", {
      personFields: "names,emailAddresses",
      pageToken: "page-2",
      syncToken: "sync-token",
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(new URL(url).searchParams.get("personFields")).toBe("names,emailAddresses");
    expect(new URL(url).searchParams.get("pageToken")).toBe("page-2");
    expect(new URL(url).searchParams.get("syncToken")).toBe("sync-token");
    expect(new URL(url).searchParams.get("pageSize")).toBe("1000");
    if (!init) throw new Error("expected a request init to have been passed to fetch");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
  });

  it("sets requestSyncToken=true only when asked", async () => {
    const fetchMock = mockPeopleApi(200, { connections: [] });
    const client = createGooglePeopleClient();

    await client.listConnections("access-token", {
      personFields: "names",
      requestSyncToken: true,
    });

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(new URL(url).searchParams.get("requestSyncToken")).toBe("true");
  });

  it("returns the connections page plus whichever tokens the response carried", async () => {
    const person = { resourceName: "people/c1", etag: "etag-1", names: [{ givenName: "Ada" }] };
    mockPeopleApi(200, { connections: [person], nextPageToken: "page-2" });
    const client = createGooglePeopleClient();

    const result = await client.listConnections("access-token", { personFields: "names" });

    expect(result).toEqual({
      connections: [person],
      nextPageToken: "page-2",
      nextSyncToken: undefined,
    });
  });

  it("throws GoogleSyncTokenExpiredError on an EXPIRED_SYNC_TOKEN ErrorInfo, never a guessed status code", async () => {
    mockPeopleApi(400, {
      error: {
        code: 400,
        message: "Sync token expired",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "EXPIRED_SYNC_TOKEN",
          },
        ],
      },
    });
    const client = createGooglePeopleClient();

    await expect(
      client.listConnections("access-token", { personFields: "names", syncToken: "stale" }),
    ).rejects.toThrow(GoogleSyncTokenExpiredError);
  });

  it("throws a plain error for any other failure response", async () => {
    mockPeopleApi(401, { error: { code: 401, message: "invalid credential" } });
    const client = createGooglePeopleClient();

    await expect(client.listConnections("access-token", { personFields: "names" })).rejects.toThrow(
      /401/,
    );
  });
});

describe("updateContact", () => {
  it("PATCHes :updateContact with the field mask, the response echo mask, the bearer token and the body verbatim", async () => {
    const person = { resourceName: "people/c1", etag: "etag-2" };
    const fetchMock = mockPeopleApi(200, person);
    const client = createGooglePeopleClient();

    const result = await client.updateContact("access-token", {
      resourceName: "people/c1",
      updatePersonFields: "names,emailAddresses",
      personFields: "names,emailAddresses,photos",
      body: { resourceName: "people/c1", etag: "etag-1", names: [] },
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/people/c1:updateContact");
    expect(new URL(url).searchParams.get("updatePersonFields")).toBe("names,emailAddresses");
    expect(new URL(url).searchParams.get("personFields")).toBe("names,emailAddresses,photos");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
    expect(JSON.parse(init.body as string)).toEqual({
      resourceName: "people/c1",
      etag: "etag-1",
      names: [],
    });
    expect(result).toEqual(person);
  });

  it('throws GoogleContactWriteRejectedError with reason "conflict" on a FAILED_PRECONDITION etag mismatch', async () => {
    mockPeopleApi(400, {
      error: { code: 400, status: "FAILED_PRECONDITION", message: "etag mismatch" },
    });
    const client = createGooglePeopleClient();

    const rejection = client.updateContact("access-token", {
      resourceName: "people/c1",
      updatePersonFields: "names",
      personFields: "names",
      body: {},
    });
    await expect(rejection).rejects.toBeInstanceOf(GoogleContactWriteRejectedError);
    await rejection.catch((err: GoogleContactWriteRejectedError) => {
      expect(err.reason).toBe("conflict");
      expect(err.status).toBe(400);
    });
  });

  it('throws GoogleContactWriteRejectedError with reason "not_found" on a 404 (the Person is gone upstream)', async () => {
    mockPeopleApi(404, { error: { code: 404, message: "not found" } });
    const client = createGooglePeopleClient();

    const rejection = client.updateContact("access-token", {
      resourceName: "people/c1",
      updatePersonFields: "names",
      personFields: "names",
      body: {},
    });
    await expect(rejection).rejects.toBeInstanceOf(GoogleContactWriteRejectedError);
    await rejection.catch((err: GoogleContactWriteRejectedError) => {
      expect(err.reason).toBe("not_found");
    });
  });

  it("throws a plain (retryable) Error, never GoogleContactWriteRejectedError, on a 5xx", async () => {
    mockPeopleApi(503, { error: { code: 503, message: "backend overloaded" } });
    const client = createGooglePeopleClient();

    const rejection = client.updateContact("access-token", {
      resourceName: "people/c1",
      updatePersonFields: "names",
      personFields: "names",
      body: {},
    });
    await expect(rejection).rejects.not.toBeInstanceOf(GoogleContactWriteRejectedError);
    await expect(rejection).rejects.toThrow(/503/);
  });
});

describe("updateContactPhoto / deleteContactPhoto", () => {
  it("PATCHes :updateContactPhoto with the base64 photoBytes body and no etag", async () => {
    const fetchMock = mockPeopleApi(200, {});
    const client = createGooglePeopleClient();

    await client.updateContactPhoto("access-token", "people/c1", "QQ==");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/people/c1:updateContactPhoto");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ photoBytes: "QQ==" });
  });

  it("throws GoogleContactWriteRejectedError on a 4xx from updateContactPhoto", async () => {
    mockPeopleApi(413, { error: { code: 413, message: "too large" } });
    const client = createGooglePeopleClient();

    await expect(
      client.updateContactPhoto("access-token", "people/c1", "QQ=="),
    ).rejects.toBeInstanceOf(GoogleContactWriteRejectedError);
  });

  it("DELETEs :deleteContactPhoto", async () => {
    const fetchMock = mockPeopleApi(200, {});
    const client = createGooglePeopleClient();

    await client.deleteContactPhoto("access-token", "people/c1");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/people/c1:deleteContactPhoto");
    expect(init.method).toBe("DELETE");
  });
});
