/**
 * A thin typed wrapper over the one Google People API endpoint this ticket
 * needs (#214) — `people.connections.list`, per
 * `docs/research/0010-contacts-sync-and-model.md` §1.1. No `googleapis`
 * dependency, the same "hand-rolled `fetch`, an interface separate from its
 * real implementation so sync logic tests against a fake" shape the sibling
 * Calendar epic's own `calendars/google/client.ts` already established.
 */

const PEOPLE_API_BASE = "https://people.googleapis.com/v1";

/**
 * A Person resource, kept as the raw shape the API returns rather than a
 * typed projection — this ticket mirrors it whole (`contacts.googlePayload`,
 * `db/schema.ts`'s own doc comment), never re-shapes it. `resourceName` and
 * `etag` are pulled out explicitly because the sync engine's own bookkeeping
 * needs them typed; everything else rides through as `unknown`.
 */
export interface GooglePerson {
  resourceName: string;
  etag: string;
  metadata?: { deleted?: boolean };
  [field: string]: unknown;
}

export interface ListConnectionsParams {
  /** Required by the API itself — must be byte-for-byte identical across every page of one walk and every incremental call built on its token (research doc §1.1: "all other parameters ... must match the first call"). */
  personFields: string;
  pageSize?: number;
  pageToken?: string;
  /** Set on the request that walks the *full* result set, to mint a token on its last page. Mutually exclusive with `syncToken` in practice, though this wrapper doesn't enforce that — the caller (`people-sync.ts`) never sets both. */
  requestSyncToken?: boolean;
  /** Set on an incremental request — the same token across every page of one round. */
  syncToken?: string;
}

export interface ListConnectionsResult {
  connections: GooglePerson[];
  /** Present when more pages remain in this round. */
  nextPageToken?: string;
  /** Present only on the last page of a `requestSyncToken`/`syncToken` round. */
  nextSyncToken?: string;
}

/**
 * Thrown when Google reports `EXPIRED_SYNC_TOKEN` (research doc §1.1/§7):
 * the reference page documents the structured `google.rpc.ErrorInfo` reason
 * but not a paired HTTP status, so this is raised off the reason string
 * alone, never a guessed status code.
 */
export class GoogleSyncTokenExpiredError extends Error {
  constructor() {
    super("Google People API: sync token expired (EXPIRED_SYNC_TOKEN)");
    this.name = "GoogleSyncTokenExpiredError";
  }
}

/**
 * A definitive rejection of a write (#216, research doc §1.4): any 4xx
 * `updateContact`/`updateContactPhoto`/`deleteContactPhoto` response —
 * `failedPrecondition`'s etag mismatch, a plain 404 (the Person is gone
 * upstream), or anything else Google's own validation rejects. Thrown
 * rather than returned so `google/write-back-loop.ts`'s `catch` can tell
 * this apart from a transient network/5xx failure (a plain `Error`, left to
 * retry on the next drain tick the same way `drainProtocolWrites` leaves a
 * failed IMAP command queued) with one `instanceof` check, never a status
 * code comparison repeated at every call site.
 */
export class GoogleContactWriteRejectedError extends Error {
  readonly reason: "conflict" | "not_found" | "rejected";
  readonly status: number;

  constructor(status: number, body: unknown) {
    super(`Google People API write rejected: ${status} ${JSON.stringify(body)}`);
    this.name = "GoogleContactWriteRejectedError";
    this.status = status;
    this.reason =
      status === 404 ? "not_found" : isPreconditionFailed(body) ? "conflict" : "rejected";
  }
}

/** `failedPrecondition` (research doc §1.4: "a 400 error with reason `failedPrecondition` if ... different than the contact's etag") — Google's own structured error, not a bare status code, since 400 alone also covers a malformed request. */
function isPreconditionFailed(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === "FAILED_PRECONDITION";
}

async function throwOnDefinitiveRejection(response: Response): Promise<never> {
  const body = await response.json().catch(() => undefined);
  if (response.status >= 400 && response.status < 500) {
    throw new GoogleContactWriteRejectedError(response.status, body);
  }
  throw new Error(`Google People API request failed: ${response.status} ${JSON.stringify(body)}`);
}

export interface UpdateContactParams {
  resourceName: string;
  updatePersonFields: string;
  /** The response's own echo mask — `people-sync.ts#GOOGLE_PERSON_FIELDS`, reused so a successful write's response is a complete, fresh mirror snapshot rather than only the families just written. */
  personFields: string;
  body: Record<string, unknown>;
}

export interface GooglePeopleClient {
  listConnections(
    accessToken: string,
    params: ListConnectionsParams,
  ): Promise<ListConnectionsResult>;
  /**
   * `people.updateContact` (#216, research doc §1.4): field-masked by
   * `updatePersonFields`, optimistic-concurrency-gated by `body.etag`.
   * Throws `GoogleContactWriteRejectedError` on any 4xx (a stale etag, a
   * deleted Person, a malformed field) — never returned as a value, so a
   * caller can't forget to check it.
   */
  updateContact(accessToken: string, params: UpdateContactParams): Promise<GooglePerson>;
  /** `people.updateContactPhoto` (#216, research doc §1.4): a categorically separate call from `updateContact` — photos aren't in `updatePersonFields`'s own writable set at all. No etag: the reference page names none for this endpoint. */
  updateContactPhoto(
    accessToken: string,
    resourceName: string,
    photoBytesBase64: string,
  ): Promise<void>;
  /** `people.deleteContactPhoto` — the removal half `updateContactPhoto` has no "clear" form of its own. */
  deleteContactPhoto(accessToken: string, resourceName: string): Promise<void>;
  /**
   * `people:createContact` (#224, the Restore write-back's own upstream
   * call): a brand-new Person for a Wicket Contact whose previous mirror
   * identity was discarded when it was deleted (ADR-0029). No `resourceName`/
   * `etag` on the way in — both come back fresh on the response, the same
   * shape `updateContact`'s own response takes.
   */
  createContact(
    accessToken: string,
    params: { personFields: string; body: Record<string, unknown> },
  ): Promise<GooglePerson>;
  /**
   * `people/{resourceName}:deleteContact` (#224, the Delete write-back's own
   * upstream call): removes Google's copy at once — Wicket's own row is
   * untouched by this call, already soft-deleted before it ever runs. Throws
   * `GoogleContactWriteRejectedError` on any 4xx the same way `updateContact`
   * does; `write-back-loop.ts`'s own drain tolerates a `not_found` (the
   * Person was already gone upstream) as nothing left to do.
   */
  deleteContact(accessToken: string, resourceName: string): Promise<void>;
}

export function createGooglePeopleClient(): GooglePeopleClient {
  return {
    async listConnections(accessToken, params) {
      const url = new URL(`${PEOPLE_API_BASE}/people/me/connections`);
      url.searchParams.set("personFields", params.personFields);
      url.searchParams.set("pageSize", String(params.pageSize ?? 1000));
      if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
      if (params.requestSyncToken) url.searchParams.set("requestSyncToken", "true");
      if (params.syncToken) url.searchParams.set("syncToken", params.syncToken);

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await response.json().catch(() => undefined);

      if (!response.ok) {
        if (isExpiredSyncTokenError(body)) throw new GoogleSyncTokenExpiredError();
        throw new Error(
          `Google People API listConnections failed: ${response.status} ${JSON.stringify(body)}`,
        );
      }

      const parsed = body as {
        connections?: GooglePerson[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      return {
        connections: parsed.connections ?? [],
        nextPageToken: parsed.nextPageToken,
        nextSyncToken: parsed.nextSyncToken,
      };
    },

    async updateContact(accessToken, { resourceName, updatePersonFields, personFields, body }) {
      const url = new URL(`${PEOPLE_API_BASE}/${resourceName}:updateContact`);
      url.searchParams.set("updatePersonFields", updatePersonFields);
      url.searchParams.set("personFields", personFields);

      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) await throwOnDefinitiveRejection(response);
      return (await response.json()) as GooglePerson;
    },

    async updateContactPhoto(accessToken, resourceName, photoBytesBase64) {
      const url = new URL(`${PEOPLE_API_BASE}/${resourceName}:updateContactPhoto`);
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ photoBytes: photoBytesBase64 }),
      });
      if (!response.ok) await throwOnDefinitiveRejection(response);
    },

    async deleteContactPhoto(accessToken, resourceName) {
      const url = new URL(`${PEOPLE_API_BASE}/${resourceName}:deleteContactPhoto`);
      const response = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) await throwOnDefinitiveRejection(response);
    },

    async createContact(accessToken, { personFields, body }) {
      const url = new URL(`${PEOPLE_API_BASE}/people:createContact`);
      url.searchParams.set("personFields", personFields);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) await throwOnDefinitiveRejection(response);
      return (await response.json()) as GooglePerson;
    },

    async deleteContact(accessToken, resourceName) {
      const url = new URL(`${PEOPLE_API_BASE}/${resourceName}:deleteContact`);
      const response = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) await throwOnDefinitiveRejection(response);
    },
  };
}

/** `google.rpc.ErrorInfo` with `reason: "EXPIRED_SYNC_TOKEN"`, nested under the standard Google API error envelope's `error.details[]`. */
function isExpiredSyncTokenError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const details = (error as { details?: unknown }).details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (detail) =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as { reason?: unknown }).reason === "EXPIRED_SYNC_TOKEN",
  );
}
