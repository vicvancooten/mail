import {
  addressBookMultiGet,
  addressBookQuery,
  getBasicAuthHeaders,
  isCollectionDirty,
  createVCard as tsdavCreateVCard,
  deleteVCard as tsdavDeleteVCard,
  fetchAddressBooks as tsdavFetchAddressBooks,
  syncCollection as tsdavSyncCollection,
  updateVCard as tsdavUpdateVCard,
} from "tsdav";

/**
 * A thin typed wrapper over `tsdav` (#226,
 * `docs/research/0009-caldav-carddav-consumption.md` §8.1's own verdict:
 * "use `tsdav` for the parts it does well" — the wire-level `sync-collection`/
 * `ctag`/`addressbook-multiget` REPORT and PROPFIND plumbing) — the same
 * "hand-rolled interface separate from its real implementation, tested
 * against a fake" shape `contacts/google/client.ts`/`contacts/microsoft/client.ts`
 * already take, so `contacts-sync.ts`/`write-back-loop.ts` never import
 * `tsdav` directly. Deliberately does **not** use `tsdav`'s own `DAVClient`/
 * `createDAVClient`/`smartCollectionSync`: both call `createAccount`'s own
 * `.well-known`/`current-user-principal` bootstrap on every use, which is
 * exactly the discovery `dav-discovery.ts` (#203) already ran once and
 * stored (`connectedAccountFacets.davHomeSetUrl`) — this wrapper is handed
 * that URL directly and never re-discovers it, and does its own upsert/
 * tombstone diffing against this app's own stored `carddavHref`s rather than
 * `smartCollectionSync`'s generic local/remote object diff.
 */

export interface CarddavCredentials {
  username: string;
  password: string;
}

export interface CarddavAddressBookSummary {
  url: string;
  displayName: string;
  ctag: string | undefined;
  /** Whether this collection's own `DAV:supported-report-set` advertises `sync-collection` (RFC 6578) — `contacts-sync.ts`'s own webdav-vs-ctag method choice, `tsdav`'s own `fetchAddressBooks` doc comment ("reports: await supportedReportSet(...)"). */
  supportsSyncCollection: boolean;
}

export interface CarddavVCard {
  href: string;
  etag: string | undefined;
  data: string;
}

export interface CarddavSyncResult {
  changed: CarddavVCard[];
  deletedHrefs: string[];
  /** Present whenever the REPORT's own multistatus carried one — RFC 6578 §3.2 mandates exactly one per response, including a "nothing changed" round, so this is only absent if a server's response shape doesn't parse the way `tsdav` expects. */
  nextSyncToken: string | undefined;
}

/**
 * Thrown when a `sync-collection` REPORT against a stored `syncToken` fails
 * in any way — research doc §2.2's own blunt conclusion: "the RFC itself
 * does not mandate a specific HTTP status code [for an invalid token] ...
 * a Sync Backend consuming a truly generic server therefore cannot rely on a
 * single status code ... it has to treat any REPORT failure against a
 * stored sync-token as a signal to fall back to a full resync." Never thrown
 * for the very first round (no stored token) — an empty/omitted `sync-token`
 * is a normal full listing per RFC 6578 §3.2, not a failure.
 */
export class CarddavSyncTokenInvalidError extends Error {
  constructor(detail: string) {
    super(`CardDAV sync-collection failed against a stored sync-token: ${detail}`);
    this.name = "CarddavSyncTokenInvalidError";
  }
}

/**
 * A definitive rejection of a write (#226) — `GoogleContactWriteRejectedError`'s
 * own shape: any 4xx `PUT`/`DELETE` response, `412 Precondition Failed`
 * (RFC 4918 §12.1's own `If-Match` failure) read as `"conflict"`, `404` as
 * `"not_found"`, anything else `"rejected"`. Thrown rather than returned so
 * `write-back-loop.ts`'s `catch` can tell this apart from a transient
 * network/5xx failure with one `instanceof` check.
 */
export class CarddavWriteRejectedError extends Error {
  readonly reason: "conflict" | "not_found" | "rejected";
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`CardDAV write rejected: ${status} ${statusText}`);
    this.name = "CarddavWriteRejectedError";
    this.status = status;
    this.reason = status === 412 ? "conflict" : status === 404 ? "not_found" : "rejected";
  }
}

export interface CarddavClient {
  /** Every address book collection under `homeSetUrl` (#203's own discovery target, Depth:1) — `contacts-sync.ts`'s own discovery walk, one call per Connected Account's Contacts Facet. */
  fetchAddressBooks(args: {
    homeSetUrl: string;
    credentials: CarddavCredentials;
  }): Promise<CarddavAddressBookSummary[]>;
  /** A cheap `PROPFIND Depth:0` for `cs:getctag` alone — the ctag-fallback poll's own "did anything change" check (research doc §2.3), read fresh every tick regardless of whether the stored one still matches. */
  fetchCtag(args: { url: string; credentials: CarddavCredentials }): Promise<string | undefined>;
  /**
   * RFC 6578's own REPORT. `syncToken: undefined` is a full listing (every
   * live member comes back `changed`, nothing `deleted` — the empty-token
   * case §3.2 itself defines); a set `syncToken` is an incremental round.
   * Throws `CarddavSyncTokenInvalidError` when a *set* `syncToken` was
   * rejected in any way (this interface's own doc comment on why that's
   * never narrowed to one status code) — never thrown for a full listing,
   * since there is no token there to have gone stale.
   */
  syncCollection(args: {
    url: string;
    syncToken: string | undefined;
    credentials: CarddavCredentials;
  }): Promise<CarddavSyncResult>;
  /** Every member's href+etag, no bodies — the ctag-fallback path's own cheap listing, ahead of `multiget`'s own batch fetch of just what's actually missing or changed locally. */
  listHrefs(args: {
    url: string;
    credentials: CarddavCredentials;
  }): Promise<{ href: string; etag: string | undefined }[]>;
  /** `CARDDAV:addressbook-multiget` (RFC 6352 §8.7) — batch-fetches the full vCard body for a set of hrefs already known to be new or changed, this ticket's own acceptance line. */
  multiget(args: {
    url: string;
    hrefs: string[];
    credentials: CarddavCredentials;
  }): Promise<CarddavVCard[]>;
  /** `PUT` with `If-None-Match: *` (RFC 6352 §6.3.2.3) at `collectionUrl` + `filename` — a brand-new vCard. Throws `CarddavWriteRejectedError` on any 4xx. */
  createVCard(args: {
    collectionUrl: string;
    filename: string;
    data: string;
    credentials: CarddavCredentials;
  }): Promise<{ href: string; etag: string | undefined }>;
  /** `PUT` with `If-Match: etag` (RFC 6352 §6.3.2) — the write-back loop's own conditional update. Throws `CarddavWriteRejectedError` on any 4xx, `"conflict"` for a `412`. */
  updateVCard(args: {
    url: string;
    etag: string;
    data: string;
    credentials: CarddavCredentials;
  }): Promise<{ etag: string | undefined }>;
  /** `DELETE` with `If-Match: etag` — same conditional discipline as `updateVCard`. */
  deleteVCard(args: { url: string; etag: string; credentials: CarddavCredentials }): Promise<void>;
}

const VCARD_PROPS = { "d:getetag": {}, "card:address-data": {} };

function authHeaders(credentials: CarddavCredentials): Record<string, string> {
  return getBasicAuthHeaders(credentials) as Record<string, string>;
}

function normalizedHref(href: string, base: string): string {
  return new URL(href, base).toString().replace(/\/+$/, "");
}

/** `tsdav`'s own XML→JS conversion returns a plain string for most servers, but wraps a CDATA-carrying value as `{_cdata: string}` (`addressBook.ts#fetchVCards`'s own `res.props?.addressData?._cdata ?? res.props?.addressData` — this mirrors it for every `props` read in this module rather than assuming a bare string). */
function propValue(props: Record<string, unknown> | undefined, key: string): unknown {
  const value = props?.[key];
  if (value && typeof value === "object" && "_cdata" in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)._cdata;
  }
  return value;
}

function extractEtag(props: Record<string, unknown> | undefined): string | undefined {
  const value = propValue(props, "getetag");
  return typeof value === "string" ? value : value != null ? String(value) : undefined;
}

function extractAddressData(props: Record<string, unknown> | undefined): string | undefined {
  const value = propValue(props, "addressData");
  return typeof value === "string" ? value : undefined;
}

export function createCarddavClient(): CarddavClient {
  return {
    async fetchAddressBooks({ homeSetUrl, credentials }) {
      const rootUrl = new URL(homeSetUrl).origin;
      const books = await tsdavFetchAddressBooks({
        account: { accountType: "carddav", serverUrl: homeSetUrl, homeUrl: homeSetUrl, rootUrl },
        headers: authHeaders(credentials),
      });
      return books.map((book) => ({
        url: book.url,
        displayName: typeof book.displayName === "string" ? book.displayName : "",
        ctag: book.ctag,
        supportsSyncCollection: (book.reports ?? []).includes("syncCollection"),
      }));
    },

    async fetchCtag({ url, credentials }) {
      const { newCtag } = await isCollectionDirty({
        collection: { url },
        headers: authHeaders(credentials),
      });
      return newCtag;
    },

    async syncCollection({ url, syncToken, credentials }) {
      const result = await tsdavSyncCollection({
        url,
        props: VCARD_PROPS,
        syncLevel: 1,
        syncToken,
        headers: authHeaders(credentials),
      });

      const isFailure = result.length === 1 && result[0] && !(result[0].ok ?? false);
      if (isFailure) {
        if (syncToken === undefined) {
          throw new Error(
            `CardDAV sync-collection failed for a full listing: ${result[0]?.status} ${result[0]?.statusText}`,
          );
        }
        throw new CarddavSyncTokenInvalidError(`${result[0]?.status} ${result[0]?.statusText}`);
      }

      const collectionHref = normalizedHref(url, url);
      const changed: CarddavVCard[] = [];
      const deletedHrefs: string[] = [];
      for (const entry of result) {
        if (!entry.href) continue;
        const href = normalizedHref(entry.href, url);
        if (href === collectionHref) continue; // the collection's own response row, not a member
        if (entry.status === 404) {
          deletedHrefs.push(href);
          continue;
        }
        const data = extractAddressData(entry.props);
        if (data === undefined) continue; // a status-only row this round otherwise reported nothing new for
        changed.push({ href, etag: extractEtag(entry.props), data });
      }

      const raw = result[0]?.raw as { multistatus?: { syncToken?: unknown } } | undefined;
      const nextSyncToken = raw?.multistatus?.syncToken;
      return {
        changed,
        deletedHrefs,
        nextSyncToken: typeof nextSyncToken === "string" ? nextSyncToken : undefined,
      };
    },

    async listHrefs({ url, credentials }) {
      const result = await addressBookQuery({
        url,
        props: { "d:getetag": {} },
        depth: "1",
        headers: authHeaders(credentials),
      });
      const collectionHref = normalizedHref(url, url);
      return result
        .filter((entry) => entry.href && normalizedHref(entry.href, url) !== collectionHref)
        .map((entry) => ({
          href: normalizedHref(entry.href as string, url),
          etag: extractEtag(entry.props),
        }));
    },

    async multiget({ url, hrefs, credentials }) {
      if (hrefs.length === 0) return [];
      const result = await addressBookMultiGet({
        url,
        props: VCARD_PROPS,
        objectUrls: hrefs,
        depth: "1",
        headers: authHeaders(credentials),
      });
      return result
        .filter((entry) => entry.ok && entry.href && extractAddressData(entry.props) !== undefined)
        .map((entry) => ({
          href: normalizedHref(entry.href as string, url),
          etag: extractEtag(entry.props),
          data: extractAddressData(entry.props) as string,
        }));
    },

    async createVCard({ collectionUrl, filename, data, credentials }) {
      const response = await tsdavCreateVCard({
        addressBook: { url: collectionUrl },
        vCardString: data,
        filename,
        headers: authHeaders(credentials),
      });
      await throwOnRejection(response);
      return {
        href: normalizedHref(new URL(filename, collectionUrl).toString(), collectionUrl),
        etag: response.headers.get("etag") ?? undefined,
      };
    },

    async updateVCard({ url, etag, data, credentials }) {
      const response = await tsdavUpdateVCard({
        vCard: { url, etag, data },
        headers: authHeaders(credentials),
      });
      await throwOnRejection(response);
      return { etag: response.headers.get("etag") ?? undefined };
    },

    async deleteVCard({ url, etag, credentials }) {
      const response = await tsdavDeleteVCard({
        vCard: { url, etag },
        headers: authHeaders(credentials),
      });
      await throwOnRejection(response);
    },
  };
}

async function throwOnRejection(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status >= 400 && response.status < 500) {
    throw new CarddavWriteRejectedError(response.status, response.statusText);
  }
  throw new Error(`CardDAV write failed: ${response.status} ${response.statusText}`);
}
