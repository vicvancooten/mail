/**
 * A thin typed wrapper over the Microsoft Graph endpoints this ticket needs
 * (#227) — contact folder discovery, `/contacts/delta`, the binary photo
 * endpoint, and the plain CRUD routes the write path uses — the same
 * "hand-rolled `fetch`, an interface separate from its real implementation
 * so sync logic tests against a fake" shape `contacts/google/client.ts`
 * already established.
 *
 * **The write path's own caveat** (this ticket's acceptance line, recorded
 * here since this is where the write actually happens): Graph does not
 * document `If-Match`/`If-None-Match` support on a contact `PATCH`, unlike
 * many other Graph resources — so `updateContact` below cannot rely on the
 * server to refuse a write against a stale `changeKey` the way a real
 * conditional request would. `contacts-sync.ts#drainMicrosoftContactWrites`
 * instead does its own compare — a fresh `getContact` read, checked against
 * the locally stored `changeKey`, before ever calling `updateContact` here.
 * That compare-then-write has an unavoidable race window (another writer
 * could land between the read and the write), so a lost update is possible
 * and is not a rollback Wicket can detect — this is exactly why Graph's own
 * capability table (`@mail/shared#contacts.ts`) declares the fewest fields
 * of the three Origins: the less Wicket ever writes here, the less that gap
 * can cost.
 */

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

/** `contactFolder` (learn.microsoft.com/graph/api/resources/contactfolder) — only the fields this ticket's own discovery walk needs. */
export interface GraphContactFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
}

/**
 * `contact` (learn.microsoft.com/graph/api/resources/contact), kept as the
 * raw shape Graph returns rather than a typed projection — this ticket
 * mirrors it whole into `contacts.microsoftPayload`
 * (`db/schema.ts`'s own doc comment), never re-shapes it there. `id` and
 * `changeKey` are pulled out explicitly because the sync engine's own
 * bookkeeping needs them typed; everything else (`mapping.ts`'s own
 * concern) rides through as `unknown`.
 */
export interface GraphContact {
  id: string;
  changeKey: string;
  categories?: string[];
  [field: string]: unknown;
}

export interface DeltaContactsResult {
  contacts: GraphContact[];
  /** Present when more pages remain in this round — the full `@odata.nextLink` URL, called verbatim. */
  nextLink?: string;
  /** Present only on the last page of a round — the full `@odata.deltaLink` URL, stored for the next round. */
  deltaLink?: string;
}

/**
 * Thrown on a `410 Gone` from `/contacts/delta` — Graph's own signal that a
 * stored `deltaLink` is too old to resume from (this ticket's own
 * acceptance line: "a stale delta token triggers a full resync"). Unlike
 * Google's `EXPIRED_SYNC_TOKEN` (a structured `google.rpc.ErrorInfo`
 * reason), Graph signals this with the plain HTTP status alone, so this is
 * raised off the status code rather than a parsed error body.
 */
export class GraphDeltaResyncRequiredError extends Error {
  constructor() {
    super("Microsoft Graph: delta link is no longer valid (410 Gone) — a full resync is required");
    this.name = "GraphDeltaResyncRequiredError";
  }
}

export interface GraphContactPhoto {
  contentType: string;
  base64: string;
}

export interface MicrosoftContactsClient {
  /** `GET /me/contactFolders` — the User's own top-level *named* folders, paged. Excludes the default root Contacts folder, which carries no `displayName` of its own to list under (`contacts-sync.ts#discoverMicrosoftContactFolders`'s own doc comment explains how that one is found instead). */
  listContactFolders(accessToken: string): Promise<GraphContactFolder[]>;
  /** The default root Contacts folder's own id, discovered via any one existing Contact's `parentFolderId` (`GET /me/contacts?$top=1&$select=parentFolderId`) — `null` when the mailbox has neither a contact nor a custom folder yet to read one off of. */
  defaultContactFolderId(accessToken: string): Promise<string | null>;
  /**
   * `GET /me/contactFolders/{folderId}/contacts/delta` — a fresh round when
   * `deltaLink` is omitted (Graph's own delta model draws no distinction
   * between a "full" and "incremental" call the way Google's
   * `requestSyncToken` does: the first call simply walks every Contact,
   * ending in a `deltaLink` for the next round), or that exact stored URL
   * verbatim otherwise (Graph's own encoded state, the same "copy and apply
   * the `@odata.nextLink`/`@odata.deltaLink` URL" contract the People API's
   * page tokens follow).
   */
  deltaContacts(
    accessToken: string,
    folderId: string,
    deltaLink?: string,
  ): Promise<DeltaContactsResult>;
  /** `GET /me/contacts/{id}` — folder-agnostic (Graph resolves a contact id across the whole mailbox regardless of which folder holds it), the write path's own fresh `changeKey` read before every `updateContact`. `null` on a 404 (deleted upstream since the local edit started). */
  getContact(accessToken: string, contactId: string): Promise<GraphContact | null>;
  /** `POST /me/contactFolders/{folderId}/contacts` — a Graph-mirrored Address Book's own `createContact` push. */
  createContact(
    accessToken: string,
    folderId: string,
    body: Record<string, unknown>,
  ): Promise<GraphContact>;
  /** `PATCH /me/contacts/{id}` — see this module's own doc comment for the `changeKey` compare-then-write caveat; this call itself carries no precondition header. */
  updateContact(
    accessToken: string,
    contactId: string,
    body: Record<string, unknown>,
  ): Promise<GraphContact>;
  /** `DELETE /me/contacts/{id}` — a no-op (never throws) when the contact is already gone upstream (a 404), the same tolerance a retried delete already gets everywhere else in this codebase. */
  deleteContact(accessToken: string, contactId: string): Promise<void>;
  /** `GET /me/contacts/{id}/photo/$value` — `null` on a 404 (no photo set). Graph enforces its own 4 MB ceiling on whatever was uploaded through Outlook, so nothing here needs to re-check size on the way down. */
  getContactPhoto(accessToken: string, contactId: string): Promise<GraphContactPhoto | null>;
}

async function graphFetch(accessToken: string, url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

async function readJsonOrThrow(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Microsoft Graph ${label} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body as Record<string, unknown>;
}

export function createMicrosoftContactsClient(): MicrosoftContactsClient {
  return {
    async listContactFolders(accessToken) {
      const folders: GraphContactFolder[] = [];
      let url = `${GRAPH_API_BASE}/me/contactFolders`;
      for (;;) {
        const response = await graphFetch(accessToken, url);
        const body = await readJsonOrThrow(response, "listContactFolders");
        const value = (body.value ?? []) as GraphContactFolder[];
        folders.push(...value);
        const next = body["@odata.nextLink"];
        if (typeof next !== "string") break;
        url = next;
      }
      return folders;
    },

    async defaultContactFolderId(accessToken) {
      const url = `${GRAPH_API_BASE}/me/contacts?$top=1&$select=parentFolderId`;
      const response = await graphFetch(accessToken, url);
      const body = await readJsonOrThrow(response, "defaultContactFolderId");
      const value = (body.value ?? []) as { parentFolderId?: string }[];
      return value[0]?.parentFolderId ?? null;
    },

    async deltaContacts(accessToken, folderId, deltaLink) {
      const url = deltaLink ?? `${GRAPH_API_BASE}/me/contactFolders/${folderId}/contacts/delta`;
      const response = await graphFetch(accessToken, url);
      if (response.status === 410) throw new GraphDeltaResyncRequiredError();
      const body = await readJsonOrThrow(response, "deltaContacts");
      const nextLink = body["@odata.nextLink"];
      const deltaLinkOut = body["@odata.deltaLink"];
      return {
        contacts: (body.value ?? []) as GraphContact[],
        nextLink: typeof nextLink === "string" ? nextLink : undefined,
        deltaLink: typeof deltaLinkOut === "string" ? deltaLinkOut : undefined,
      };
    },

    async getContact(accessToken, contactId) {
      const response = await graphFetch(accessToken, `${GRAPH_API_BASE}/me/contacts/${contactId}`);
      if (response.status === 404) return null;
      return (await readJsonOrThrow(response, "getContact")) as unknown as GraphContact;
    },

    async createContact(accessToken, folderId, body) {
      const response = await graphFetch(
        accessToken,
        `${GRAPH_API_BASE}/me/contactFolders/${folderId}/contacts`,
        { method: "POST", body: JSON.stringify(body) },
      );
      return (await readJsonOrThrow(response, "createContact")) as unknown as GraphContact;
    },

    async updateContact(accessToken, contactId, body) {
      const response = await graphFetch(accessToken, `${GRAPH_API_BASE}/me/contacts/${contactId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return (await readJsonOrThrow(response, "updateContact")) as unknown as GraphContact;
    },

    async deleteContact(accessToken, contactId) {
      const response = await graphFetch(accessToken, `${GRAPH_API_BASE}/me/contacts/${contactId}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Microsoft Graph deleteContact failed: ${response.status}`);
      }
    },

    async getContactPhoto(accessToken, contactId) {
      const response = await graphFetch(
        accessToken,
        `${GRAPH_API_BASE}/me/contacts/${contactId}/photo/$value`,
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Microsoft Graph getContactPhoto failed: ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "image/jpeg";
      const bytes = Buffer.from(await response.arrayBuffer());
      return { contentType, base64: bytes.toString("base64") };
    },
  };
}
