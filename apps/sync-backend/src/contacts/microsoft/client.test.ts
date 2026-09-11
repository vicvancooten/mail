import { afterEach, describe, expect, it, vi } from "vitest";
import { createMicrosoftContactsClient, GraphDeltaResyncRequiredError } from "./client.js";

/**
 * The real Microsoft Graph contacts client (#227) — the wire format alone,
 * the same division `google/client.test.ts` draws for its own People API
 * client: `contacts-sync.test.ts` drives the sync engine through a fake
 * `MicrosoftContactsClient`, this file's whole job is "what goes out on the
 * request and what a response maps to".
 */

function mockGraphApi(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listContactFolders", () => {
  it("sends the bearer token and pages through @odata.nextLink", async () => {
    const fetchMock = mockGraphApi((url) => {
      if (url.includes("nextpage")) {
        return jsonResponse(200, { value: [{ id: "f2", displayName: "Work" }] });
      }
      return jsonResponse(200, {
        value: [{ id: "f1", displayName: "Family", parentFolderId: "root" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/contactFolders?nextpage",
      });
    });
    const client = createMicrosoftContactsClient();

    const folders = await client.listContactFolders("access-token");

    expect(folders).toEqual([
      { id: "f1", displayName: "Family", parentFolderId: "root" },
      { id: "f2", displayName: "Work" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
  });
});

describe("defaultContactFolderId", () => {
  it("reads parentFolderId off any one existing contact", async () => {
    mockGraphApi((url) => {
      expect(url).toContain("/me/contacts?");
      expect(url).toContain("$top=1");
      return jsonResponse(200, { value: [{ parentFolderId: "root-folder-id" }] });
    });
    const client = createMicrosoftContactsClient();

    expect(await client.defaultContactFolderId("access-token")).toBe("root-folder-id");
  });

  it("is null for a mailbox with no contact yet", async () => {
    mockGraphApi(() => jsonResponse(200, { value: [] }));
    const client = createMicrosoftContactsClient();

    expect(await client.defaultContactFolderId("access-token")).toBeNull();
  });
});

describe("deltaContacts", () => {
  it("calls the folder-scoped delta endpoint when no deltaLink is stored", async () => {
    const fetchMock = mockGraphApi((url) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/me/contactFolders/f1/contacts/delta");
      return jsonResponse(200, {
        value: [{ id: "c1", changeKey: "ck1" }],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/contactFolders/f1/contacts/delta?token=1",
      });
    });
    const client = createMicrosoftContactsClient();

    const result = await client.deltaContacts("access-token", "f1");

    expect(result.contacts).toEqual([{ id: "c1", changeKey: "ck1" }]);
    expect(result.deltaLink).toBe(
      "https://graph.microsoft.com/v1.0/me/contactFolders/f1/contacts/delta?token=1",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls the stored deltaLink verbatim, folderId unused", async () => {
    const storedLink =
      "https://graph.microsoft.com/v1.0/me/contactFolders/f1/contacts/delta?token=1";
    const fetchMock = mockGraphApi((url) => {
      expect(url).toBe(storedLink);
      return jsonResponse(200, { value: [] });
    });
    const client = createMicrosoftContactsClient();

    await client.deltaContacts("access-token", "f1", storedLink);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws GraphDeltaResyncRequiredError on a 410 Gone, never a guessed error shape", async () => {
    mockGraphApi(() => new Response(null, { status: 410 }));
    const client = createMicrosoftContactsClient();

    await expect(client.deltaContacts("access-token", "f1", "stale-link")).rejects.toThrow(
      GraphDeltaResyncRequiredError,
    );
  });
});

describe("getContact", () => {
  it("returns null on a 404", async () => {
    mockGraphApi(() => new Response(null, { status: 404 }));
    const client = createMicrosoftContactsClient();

    expect(await client.getContact("access-token", "missing")).toBeNull();
  });

  it("returns the parsed contact otherwise", async () => {
    mockGraphApi(() => jsonResponse(200, { id: "c1", changeKey: "ck2" }));
    const client = createMicrosoftContactsClient();

    expect(await client.getContact("access-token", "c1")).toEqual({ id: "c1", changeKey: "ck2" });
  });
});

describe("createContact / updateContact / deleteContact", () => {
  it("POSTs a new contact into the given folder", async () => {
    const fetchMock = mockGraphApi((url, init) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/me/contactFolders/f1/contacts");
      expect(init?.method).toBe("POST");
      return jsonResponse(201, { id: "new-id", changeKey: "ck1" });
    });
    const client = createMicrosoftContactsClient();

    const created = await client.createContact("access-token", "f1", { givenName: "Ada" });
    expect(created).toEqual({ id: "new-id", changeKey: "ck1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PATCHes an existing contact by id, folder-agnostic", async () => {
    mockGraphApi((url, init) => {
      expect(url).toBe("https://graph.microsoft.com/v1.0/me/contacts/c1");
      expect(init?.method).toBe("PATCH");
      return jsonResponse(200, { id: "c1", changeKey: "ck2" });
    });
    const client = createMicrosoftContactsClient();

    const updated = await client.updateContact("access-token", "c1", { givenName: "Grace" });
    expect(updated).toEqual({ id: "c1", changeKey: "ck2" });
  });

  it("DELETEs and tolerates an already-gone 404", async () => {
    mockGraphApi(() => new Response(null, { status: 404 }));
    const client = createMicrosoftContactsClient();

    await expect(client.deleteContact("access-token", "c1")).resolves.toBeUndefined();
  });
});

describe("getContactPhoto", () => {
  it("returns null on a 404 (no photo set)", async () => {
    mockGraphApi(() => new Response(null, { status: 404 }));
    const client = createMicrosoftContactsClient();

    expect(await client.getContactPhoto("access-token", "c1")).toBeNull();
  });

  it("base64-encodes the binary body with its content-type", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mockGraphApi(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const client = createMicrosoftContactsClient();

    const photo = await client.getContactPhoto("access-token", "c1");
    expect(photo?.contentType).toBe("image/jpeg");
    expect(photo?.base64).toBe(Buffer.from(bytes).toString("base64"));
  });
});
