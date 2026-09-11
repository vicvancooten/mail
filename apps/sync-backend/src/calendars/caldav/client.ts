import { XMLParser } from "fast-xml-parser";

/**
 * A thin, hand-rolled CalDAV transport (#247) — `fetch` plus `fast-xml-parser`,
 * the same choice `connected-accounts/dav-discovery.ts` already made for the
 * discovery chain, continued here rather than pulling in `tsdav`: every call
 * this file needs (`PROPFIND`, `REPORT`, `PUT`) is a handful of XML bodies
 * over plain HTTP, and staying on the same transport `dav-discovery.ts`
 * already proved out means one set of namespace-tolerant parsing helpers for
 * the whole CalDAV surface, not two.
 *
 * `CaldavCalendarClient` is an interface, not just this file's own function
 * exports, so `calendar-list-sync.ts`/`event-sync.ts`/`outbox-processor.ts`
 * can be exercised in a unit test against a hand-rolled fake instead of a
 * live CalDAV server — `google/client.ts`'s own reasoning.
 */

const STEP_TIMEOUT_MS = 15_000;

export interface CaldavAuth {
  username: string;
  password: string;
}

/** One calendar collection PROPFIND turns up under a Facet's home-set. */
export interface CaldavCalendarEntry {
  /** The collection's own URL, resolved against the home-set. */
  href: string;
  displayName: string;
  color: string | null;
  timeZone: string | null;
  /** `{DAV:}getctag` (the CalendarServer extension nearly every server implements) — `null` on a server that omits it entirely. */
  ctag: string | null;
  /** Computed from `current-user-privilege-set` (this ticket's own acceptance line): `{DAV:}write` or `{DAV:}write-content`. */
  writable: boolean;
  /** Probed from the `calendar-auto-schedule` DAV capability (this ticket's own acceptance line, RFC 6638 §7.1's `DAV` response header). */
  invitesSentByUpstream: boolean;
}

export interface CaldavObjectRef {
  href: string;
  etag: string;
}

export interface CaldavObject {
  href: string;
  etag: string;
  scheduleTag: string | null;
  icsData: string;
}

/** `sync-collection`'s own outcome shape (RFC 6578) — a stale/invalid token is a distinct case from an ordinary page, never thrown as a generic error, so `event-sync.ts` can tell "re-walk" apart from "something actually broke". */
export type CaldavSyncResult =
  | {
      kind: "ok";
      changed: CaldavObjectRef[];
      deletedHrefs: string[];
      syncToken: string;
    }
  | { kind: "staleToken" };

export interface CaldavCalendarClient {
  /** Depth-1 PROPFIND of the Facet's own home-set (#203's own discovery output) — one entry per calendar collection, `current-user-privilege-set`/`calendar-auto-schedule` folded in per entry so nothing here needs a second round trip per calendar. */
  listCalendars(auth: CaldavAuth, homeSetUrl: string): Promise<CaldavCalendarEntry[]>;
  /** `{DAV:}getctag`, Depth 0, on one calendar collection — the fallback check "before asking for changes" (this ticket's own acceptance line). */
  getCtag(auth: CaldavAuth, calendarUrl: string): Promise<string | null>;
  /** `sync-collection` REPORT (RFC 6578) — `syncToken` omitted means "initial sync", which returns every current object as `changed` and nothing as `deletedHrefs`. */
  syncCollection(
    auth: CaldavAuth,
    calendarUrl: string,
    syncToken?: string,
  ): Promise<CaldavSyncResult>;
  /** `calendar-multiget` REPORT (RFC 4791 §7.9) — batch-fetches the full `.ics` body for every href `syncCollection` named as changed. */
  multiget(auth: CaldavAuth, calendarUrl: string, hrefs: string[]): Promise<CaldavObject[]>;
  /**
   * `PUT` one calendar object, conditional on `ifMatchEtag` when given
   * (`If-Match`) — omitted entirely for a brand-new object, where
   * `If-None-Match: *` guards against overwriting a resource that already
   * exists at this href (a UID collision, or a retried create that already
   * landed).
   */
  putObject(
    auth: CaldavAuth,
    url: string,
    icsBody: string,
    opts: {
      ifMatchEtag?: string | null;
      /** RFC 6638 §3.3's second axis — sent as `If-Schedule-Tag-Match` alongside (never instead of) `If-Match` when the caller has one. */
      ifScheduleTagMatch?: string | null;
      isCreate: boolean;
    },
  ): Promise<{ etag: string | null; scheduleTag: string | null }>;
}

export type CaldavWriteErrorKind = "conflict" | "permanent" | "transient" | "needsReauth";

export class CaldavWriteError extends Error {
  readonly kind: CaldavWriteErrorKind;
  readonly status: number;
  constructor(kind: CaldavWriteErrorKind, status: number, detail: string) {
    super(`CalDAV write error (${status}): ${detail}`);
    this.name = "CaldavWriteError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * `412 Precondition Failed` is `If-Match`/`If-Schedule-Tag-Match`'s own
 * rejection (a conflict, ADR-0025's second shape); `401` is a rejected
 * credential reached mid-flight; `403`/`423` (forbidden/locked) and `429`/
 * `5xx` are the same transient/permanent split `google/client.ts
 * #classifyWriteStatus` already draws — everything else in the 4xx range is
 * a permanent rejection of this specific write.
 */
function classifyWriteStatus(status: number): CaldavWriteErrorKind {
  if (status === 412) return "conflict";
  if (status === 401) return "needsReauth";
  if (status === 423 || status === 429 || status >= 500) return "transient";
  return "permanent";
}

function basicAuthHeader(auth: CaldavAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")}`;
}

async function davFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// --- namespace-tolerant multistatus parsing (`dav-discovery.ts`'s own idiom) --

function parseXml(xml: string): unknown {
  try {
    return new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
    }).parse(xml);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function findTag(node: unknown, tag: string): unknown {
  if (!isRecord(node)) return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase() === tag.toLowerCase()) return value;
  }
  for (const value of Object.values(node)) {
    for (const item of toArray(value)) {
      const found = findTag(item, tag);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function textOf(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (isRecord(node) && typeof node["#text"] === "string") return node["#text"];
  return null;
}

function findText(node: unknown, tag: string): string | null {
  return textOf(findTag(node, tag));
}

function hasHref(container: unknown): container is { href: unknown } {
  return isRecord(container) && "href" in container;
}

/** Every `<D:response>` in a multistatus body, each already resolved to its own `<D:propstat><D:prop>` object — the one shape every helper below reads from. */
function multistatusResponses(
  xml: string,
  baseUrl: string,
): { href: string; prop: Record<string, unknown> }[] {
  const doc = parseXml(xml);
  const multistatus = isRecord(doc) ? doc.multistatus : undefined;
  const responses = toArray(isRecord(multistatus) ? multistatus.response : undefined);
  const out: { href: string; prop: Record<string, unknown> }[] = [];
  for (const entry of responses) {
    if (!isRecord(entry) || typeof entry.href !== "string") continue;
    const href = new URL(entry.href, baseUrl).toString();
    const prop = toArray(entry.propstat)
      .map((propstat) => (isRecord(propstat) ? propstat.prop : undefined))
      .find(isRecord);
    out.push({ href, prop: prop ?? {} });
  }
  return out;
}

/** `{DAV:}write` or `{DAV:}write-content` anywhere in `current-user-privilege-set` (this ticket's own acceptance line). */
function computeWritable(prop: Record<string, unknown>): boolean {
  const privilegeSet = prop["current-user-privilege-set"];
  if (!isRecord(privilegeSet)) return false;
  for (const privilege of toArray(privilegeSet.privilege)) {
    if (!isRecord(privilege)) continue;
    if ("write" in privilege || "write-content" in privilege || "all" in privilege) return true;
  }
  return false;
}

const CALENDAR_LIST_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <D:current-user-privilege-set/>
    <C:calendar-color/>
    <C:calendar-timezone/>
    <CS:getctag/>
  </D:prop>
</D:propfind>`;

const GETCTAG_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop><CS:getctag/></D:prop>
</D:propfind>`;

function syncCollectionReportBody(syncToken: string | undefined): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:sync-collection xmlns:D="DAV:">
  <D:sync-token>${syncToken ?? ""}</D:sync-token>
  <D:sync-level>1</D:sync-level>
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;
}

function multigetReportBody(hrefPaths: string[]): string {
  const hrefs = hrefPaths.map((href) => `<D:href>${escapeXml(href)}</D:href>`).join("");
  return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  ${hrefs}
</C:calendar-multiget>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Whether a calendar collection's own `OPTIONS` response advertises the
 * `calendar-auto-schedule` DAV capability (RFC 6638 §7.1) — a plain header
 * check, not a WebDAV property, since RFC 6638 defines this as a token in
 * the `DAV:` response header alongside `calendar-access` etc., the same
 * place `1, 2, 3, calendar-access` itself already lives.
 */
async function probesAutoSchedule(auth: CaldavAuth, url: string): Promise<boolean> {
  const response = await davFetch(url, {
    method: "OPTIONS",
    headers: { Authorization: basicAuthHeader(auth) },
  });
  const davHeader = response.headers.get("dav") ?? "";
  return davHeader.toLowerCase().includes("calendar-auto-schedule");
}

/** The real implementation, hitting a live CalDAV server. `createCaldavCalendarClient()` with no arguments is the production instance. */
export function createCaldavCalendarClient(): CaldavCalendarClient {
  return {
    async listCalendars(auth, homeSetUrl) {
      const response = await davFetch(homeSetUrl, {
        method: "PROPFIND",
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: "1",
          Authorization: basicAuthHeader(auth),
        },
        body: CALENDAR_LIST_PROPFIND_BODY,
      });
      if (response.status !== 207) return [];
      const body = await response.text();
      const normalizedHomeSet = homeSetUrl.replace(/\/+$/, "");
      const entries: CaldavCalendarEntry[] = [];
      for (const { href, prop } of multistatusResponses(body, homeSetUrl)) {
        if (href.replace(/\/+$/, "") === normalizedHomeSet) continue; // the home-set collection itself
        if (!isRecord(prop.resourcetype) || !("calendar" in prop.resourcetype)) continue;

        const displayName = findText(prop, "displayname") ?? href;
        const color = findText(prop, "calendar-color");
        const timeZoneIcs = findText(prop, "calendar-timezone");
        const ctag = findText(prop, "getctag");
        const writable = computeWritable(prop);
        const invitesSentByUpstream = await probesAutoSchedule(auth, href);
        entries.push({
          href,
          displayName,
          color: color ? normalizeColor(color) : null,
          timeZone: timeZoneIcs ? extractTzid(timeZoneIcs) : null,
          ctag,
          writable,
          invitesSentByUpstream,
        });
      }
      return entries;
    },

    async getCtag(auth, calendarUrl) {
      const response = await davFetch(calendarUrl, {
        method: "PROPFIND",
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: "0",
          Authorization: basicAuthHeader(auth),
        },
        body: GETCTAG_PROPFIND_BODY,
      });
      if (response.status !== 207) return null;
      const body = await response.text();
      return findText(parseXml(body), "getctag");
    },

    async syncCollection(auth, calendarUrl, syncToken) {
      const response = await davFetch(calendarUrl, {
        method: "REPORT",
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: "1",
          Authorization: basicAuthHeader(auth),
        },
        body: syncCollectionReportBody(syncToken),
      });
      // RFC 6578 §3.2: a sync-token the server no longer recognizes answers
      // `403 Forbidden` with a `valid-sync-token` precondition — never a
      // generic error `event-sync.ts` should throw past.
      if (response.status === 403) return { kind: "staleToken" };
      if (response.status !== 207) return { kind: "staleToken" };

      const body = await response.text();
      const doc = parseXml(body);
      const multistatus = isRecord(doc) ? doc.multistatus : undefined;
      const newSyncToken = findText(multistatus, "sync-token") ?? "";
      const changed: CaldavObjectRef[] = [];
      const deletedHrefs: string[] = [];
      const responses = toArray(isRecord(multistatus) ? multistatus.response : undefined);
      for (const entry of responses) {
        if (!hasHref(entry) || typeof entry.href !== "string") continue;
        const href = new URL(entry.href, calendarUrl).toString();
        const status = findStatusCode(entry);
        if (status === 404) {
          deletedHrefs.push(href);
          continue;
        }
        const prop = toArray((entry as Record<string, unknown>).propstat)
          .map((propstat) => (isRecord(propstat) ? propstat.prop : undefined))
          .find(isRecord);
        const etag = prop ? findText(prop, "getetag") : null;
        if (etag) changed.push({ href, etag: stripEtagQuotes(etag) });
      }
      return { kind: "ok", changed, deletedHrefs, syncToken: newSyncToken };
    },

    async multiget(auth, calendarUrl, hrefs) {
      if (hrefs.length === 0) return [];
      const hrefPaths = hrefs.map((href) => new URL(href).pathname);
      const response = await davFetch(calendarUrl, {
        method: "REPORT",
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          Depth: "1",
          Authorization: basicAuthHeader(auth),
        },
        body: multigetReportBody(hrefPaths),
      });
      if (response.status !== 207) return [];
      const body = await response.text();
      const doc = parseXml(body);
      const multistatus = isRecord(doc) ? doc.multistatus : undefined;
      const responses = toArray(isRecord(multistatus) ? multistatus.response : undefined);
      const objects: CaldavObject[] = [];
      for (const entry of responses) {
        if (!hasHref(entry) || typeof entry.href !== "string") continue;
        const href = new URL(entry.href, calendarUrl).toString();
        const prop = toArray((entry as Record<string, unknown>).propstat)
          .map((propstat) => (isRecord(propstat) ? propstat.prop : undefined))
          .find(isRecord);
        if (!prop) continue;
        const etag = findText(prop, "getetag");
        const icsData = findText(prop, "calendar-data");
        if (!etag || !icsData) continue;
        objects.push({ href, etag: stripEtagQuotes(etag), scheduleTag: null, icsData });
      }
      return objects;
    },

    async putObject(auth, url, icsBody, opts) {
      const headers: Record<string, string> = {
        "Content-Type": "text/calendar; charset=utf-8",
        Authorization: basicAuthHeader(auth),
      };
      if (opts.isCreate) {
        headers["If-None-Match"] = "*";
      } else if (opts.ifMatchEtag) {
        headers["If-Match"] = opts.ifMatchEtag;
      }
      if (!opts.isCreate && opts.ifScheduleTagMatch) {
        headers["If-Schedule-Tag-Match"] = opts.ifScheduleTagMatch;
      }
      const response = await davFetch(url, { method: "PUT", headers, body: icsBody });
      if (!response.ok) {
        const detail = await response.text().catch(() => response.statusText);
        throw new CaldavWriteError(classifyWriteStatus(response.status), response.status, detail);
      }
      const etag = response.headers.get("etag");
      const scheduleTag = response.headers.get("schedule-tag");
      return {
        etag: etag ? stripEtagQuotes(etag) : null,
        scheduleTag: scheduleTag ? stripEtagQuotes(scheduleTag) : null,
      };
    },
  };
}

function findStatusCode(entry: Record<string, unknown>): number | null {
  const status = typeof entry.status === "string" ? entry.status : null;
  if (!status) return null;
  const match = status.match(/(\d{3})/);
  return match ? Number(match[1]) : null;
}

/** Weak/strong ETags alike arrive quoted (`"abc123"`) — stored and compared bare, `dav-discovery.ts`'s own tolerance for server formatting quirks extended to this one more field. */
function stripEtagQuotes(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

/** `calendar-color` is commonly `#RRGGBBAA` (an alpha channel Wicket's own colour swatch has no use for) — trimmed to the `#RRGGBB` every other Origin's `color` column already stores. */
function normalizeColor(color: string): string {
  return color.length === 9 ? color.slice(0, 7) : color;
}

/** `calendar-timezone` is a full `VTIMEZONE` component — only its own `TZID` is what `calendars.timeZone` stores. */
function extractTzid(vtimezone: string): string | null {
  const match = vtimezone.match(/TZID:([^\r\n]+)/);
  return match?.[1] ? match[1].trim() : null;
}
