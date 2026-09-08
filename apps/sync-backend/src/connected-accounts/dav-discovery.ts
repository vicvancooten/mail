import { resolveSrv as dnsResolveSrv } from "node:dns/promises";
import type { DavDiscoveryFailureReason, DavDiscoverySummary, DavFacet } from "@mail/shared";
import { XMLParser } from "fast-xml-parser";

/** "A few seconds," per-attempt, matching `mail-accounts/autodiscover.ts`'s own STEP_TIMEOUT_MS — CalDAV/CardDAV servers are no less likely to hang than a mail autoconfig host. */
const STEP_TIMEOUT_MS = 8000;

export type { DavFacet };

export interface DavDiscoveryInput {
  /** What the User typed into the cell's inline form: a server address (host, URL, or `user@host`) or an email address. */
  serverAddress: string;
  username: string;
  password: string;
  facet: DavFacet;
}

export type DavDiscoveryResult =
  | {
      ok: true;
      principalUrl: string;
      homeSetUrl: string;
      supportsScheduling: boolean;
      collections: DavDiscoverySummary;
    }
  | { ok: false; reason: DavDiscoveryFailureReason };

export interface DavDiscoveryDeps {
  fetchImpl: typeof fetch;
  resolveSrv: typeof dnsResolveSrv;
}

const defaultDeps: DavDiscoveryDeps = { fetchImpl: fetch, resolveSrv: dnsResolveSrv };

/**
 * iCloud and Fastmail publish fixed hostnames and nothing discoverable from
 * their mail domain (#203's own body: ".well-known"/SRV against
 * `icloud.com`/`fastmail.com` itself just fails) — these short-circuit
 * straight to the known host rather than entering the general chain at all.
 * Deliberately small and app-specific rather than an exhaustive provider
 * list: every other server is expected to answer RFC 6764 properly, and a
 * domain no rule matches here just runs the general chain instead — this
 * table is a shortcut for two known-uncooperative providers, not the
 * discovery mechanism itself.
 */
const KNOWN_HOSTS: {
  matchesDomain: (domain: string) => boolean;
  host: Record<DavFacet, string>;
}[] = [
  {
    matchesDomain: (domain) => /(^|\.)(icloud\.com|me\.com|mac\.com)$/i.test(domain),
    host: { calendar: "caldav.icloud.com", contacts: "contacts.icloud.com" },
  },
  {
    matchesDomain: (domain) => /(^|\.)fastmail\.(com|fm)$/i.test(domain),
    host: { calendar: "caldav.fastmail.com", contacts: "carddav.fastmail.com" },
  },
];

/**
 * The discovery pipeline (#203's own body and acceptance criteria): a
 * `.well-known` bootstrap → `current-user-principal` PROPFIND → home-set,
 * tried in order against the entered value as a base URL, then `.well-known`
 * on its host, then a DNS SRV lookup — a known-host table for iCloud and
 * Fastmail short-circuits straight past all three. Stops at the first
 * candidate that actually **answers** (an authenticated PROPFIND response,
 * whether or not it has what this Facet needs) rather than the first one
 * that succeeds outright — a candidate is only skipped on a network-level
 * miss (`unreachable`), never on a definitive negative answer from a real
 * server, since credentials rejected or "no home-set here" on one candidate
 * would be exactly as true on every other candidate this same
 * username/password is tried against.
 */
export async function discoverDavAccount(
  input: DavDiscoveryInput,
  deps: DavDiscoveryDeps = defaultDeps,
): Promise<DavDiscoveryResult> {
  const auth = basicAuthHeader(input.username, input.password);
  const parsed = parseServerAddress(input.serverAddress);
  const knownHost =
    parsed.emailDomain !== null
      ? KNOWN_HOSTS.find((candidate) => candidate.matchesDomain(parsed.emailDomain as string))
      : undefined;

  if (knownHost) {
    return toResult(
      await discoverAgainstHost(deps, `https://${knownHost.host[input.facet]}/`, input.facet, auth),
    );
  }

  for await (const base of candidateBases(deps, parsed, input.facet)) {
    const attempt = await discoverAgainstHost(deps, base, input.facet, auth);
    if (attempt.status !== "unreachable") {
      return toResult(attempt);
    }
  }
  return { ok: false, reason: "unreachable" };
}

interface ParsedServerAddress {
  /**
   * Set only when the entered value is itself URL-ish (has a scheme) or a
   * bare host — "the entered value as a base URL" candidate, tried before
   * anything else. Null for an email address, where there's nothing to
   * PROPFIND directly; `domain` is what the rest of the chain derives from
   * either way.
   */
  directUrl: string | null;
  domain: string;
  /**
   * The domain part of an entered *email address*, and only that — null
   * whenever the User typed a host or URL directly, even though `domain`
   * above is populated in that case too. #203's closing comment: the known-
   * host table is matched off the entered value's email domain only, "never
   * a bare host/URL the User already typed explicitly" — so this is the one
   * field `discoverDavAccount` may check the known-host table against.
   */
  emailDomain: string | null;
}

function parseServerAddress(value: string): ParsedServerAddress {
  const trimmed = value.trim();
  if (trimmed.includes("://")) {
    const url = new URL(trimmed);
    return { directUrl: url.toString(), domain: url.hostname, emailDomain: null };
  }
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex !== -1) {
    const domain = trimmed.slice(atIndex + 1);
    return { directUrl: null, domain, emailDomain: domain };
  }
  return { directUrl: `https://${trimmed}/`, domain: trimmed, emailDomain: null };
}

/**
 * Lazy by construction: the well-known bootstrap only ever fetches once
 * this generator's second candidate is actually pulled, and the SRV lookup
 * only once a third is — so a candidate earlier in the chain answering
 * (`discoverDavAccount`'s own stop condition) means the later ones never run
 * a network call at all.
 */
async function* candidateBases(
  deps: DavDiscoveryDeps,
  parsed: ParsedServerAddress,
  facet: DavFacet,
): AsyncGenerator<string> {
  const tried = new Set<string>();
  if (parsed.directUrl) {
    tried.add(parsed.directUrl);
    yield parsed.directUrl;
  }

  const wellKnownBase =
    (await resolveWellKnownBase(deps, parsed.domain, facet)) ?? `https://${parsed.domain}/`;
  if (!tried.has(wellKnownBase)) {
    tried.add(wellKnownBase);
    yield wellKnownBase;
  }

  const srvBase = await resolveSrvBase(deps, parsed.domain, facet);
  if (srvBase && !tried.has(srvBase)) {
    yield srvBase;
  }
}

/**
 * RFC 6764 §7's bootstrap: a plain `GET` (not a PROPFIND — nothing here
 * needs the response body, only the redirect) at `/.well-known/{caldav,carddav}`,
 * followed manually rather than through `fetch`'s own redirect handling —
 * WebDAV user agents are expected to re-issue the *original* method at the
 * resolved location, and `fetch`'s automatic follow can downgrade a
 * non-`GET` method on a 301/302. `null` on anything but a redirect: no
 * `Location`, a network failure, or a well-known path that isn't even
 * implemented — the caller's own `?? https://<domain>/` is the fallback.
 */
async function resolveWellKnownBase(
  deps: DavDiscoveryDeps,
  domain: string,
  facet: DavFacet,
): Promise<string | null> {
  const path = facet === "calendar" ? "/.well-known/caldav" : "/.well-known/carddav";
  const url = `https://${domain}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        return new URL(location, url).toString();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * RFC 6764 §6: `_caldavs._tcp`/`_carddavs._tcp` SRV records name the actual
 * server directly, so — unlike the well-known step — there is no plain-text
 * `_caldav`/`_carddav` fallback tried here, mirroring `autodiscover.ts`'s own
 * TLS-first bias for a service this app will only ever speak HTTPS to.
 */
async function resolveSrvBase(
  deps: DavDiscoveryDeps,
  domain: string,
  facet: DavFacet,
): Promise<string | null> {
  const service = facet === "calendar" ? "_caldavs._tcp" : "_carddavs._tcp";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const records = await Promise.race([
      deps.resolveSrv(`${service}.${domain}`),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error("SRV lookup timed out")),
        );
      }),
    ]);
    const best = [...records].sort((a, b) => a.priority - b.priority)[0];
    if (!best || best.name === "." || best.name === "") {
      return null;
    }
    const port = best.port === 443 ? "" : `:${best.port}`;
    return `https://${best.name}${port}/`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

type HostAttemptResult =
  | { status: "unreachable" }
  | { status: "rejected" }
  | { status: "no_home_set" }
  | {
      status: "ok";
      principalUrl: string;
      homeSetUrl: string;
      supportsScheduling: boolean;
      collections: DavDiscoverySummary;
    };

function toResult(attempt: HostAttemptResult): DavDiscoveryResult {
  switch (attempt.status) {
    case "ok":
      return {
        ok: true,
        principalUrl: attempt.principalUrl,
        homeSetUrl: attempt.homeSetUrl,
        supportsScheduling: attempt.supportsScheduling,
        collections: attempt.collections,
      };
    case "rejected":
      return { ok: false, reason: "credentials_rejected" };
    case "no_home_set":
      return { ok: false, reason: "no_home_set" };
    case "unreachable":
      return { ok: false, reason: "unreachable" };
  }
}

/**
 * `current-user-principal` → home-set (+ RFC 6638 scheduling props) →
 * Depth-1 collection enumeration, all against one resolved base URL. Only a
 * network-level miss at the *first* step (nothing answered at all) comes
 * back `unreachable` — every other outcome here is a real server's real
 * answer, so `discoverDavAccount`'s candidate loop never keeps trying once
 * this returns anything else.
 */
async function discoverAgainstHost(
  deps: DavDiscoveryDeps,
  baseUrl: string,
  facet: DavFacet,
  auth: string,
): Promise<HostAttemptResult> {
  const principalResponse = await propfind(deps, baseUrl, PRINCIPAL_PROPFIND_BODY, auth, "0");
  if (!principalResponse) return { status: "unreachable" };
  if (principalResponse.status === 401 || principalResponse.status === 403)
    return { status: "rejected" };
  if (principalResponse.status !== 207) return { status: "unreachable" };

  const principalHref = extractHref(principalResponse.body, "current-user-principal");
  if (!principalHref) return { status: "no_home_set" };
  const principalUrl = new URL(principalHref, baseUrl).toString();

  const homeSetResponse = await propfind(deps, principalUrl, homeSetPropfindBody(facet), auth, "0");
  if (!homeSetResponse) return { status: "unreachable" };
  if (homeSetResponse.status === 401 || homeSetResponse.status === 403)
    return { status: "rejected" };
  if (homeSetResponse.status !== 207) return { status: "no_home_set" };

  const homeSetTag = facet === "calendar" ? "calendar-home-set" : "addressbook-home-set";
  const homeSetHref = extractHref(homeSetResponse.body, homeSetTag);
  if (!homeSetHref) return { status: "no_home_set" };
  const homeSetUrl = new URL(homeSetHref, principalUrl).toString();

  // RFC 6638 has no CardDAV analogue — a Contacts Facet never advertises
  // scheduling regardless of what a server happens to answer with here.
  const supportsScheduling =
    facet === "calendar" &&
    (hasTag(homeSetResponse.body, "schedule-inbox-URL") ||
      hasTag(homeSetResponse.body, "schedule-outbox-URL"));

  return {
    status: "ok",
    principalUrl,
    homeSetUrl,
    supportsScheduling,
    collections: await listCollections(deps, homeSetUrl, facet, auth),
  };
}

/**
 * The Depth-1 enumeration behind "3 calendars, 1 address book" (#203's own
 * body). Deliberately tolerant of failure here: principal and home-set
 * discovery has already succeeded by the time this runs, which is the part
 * that decides whether the Facet turns on at all — a server that times out
 * on this one extra round trip reports zero collections rather than failing
 * discovery outright over what is, at this point, cosmetic feedback.
 */
async function listCollections(
  deps: DavDiscoveryDeps,
  homeSetUrl: string,
  facet: DavFacet,
  auth: string,
): Promise<DavDiscoverySummary> {
  const response = await propfind(deps, homeSetUrl, collectionPropfindBody(facet), auth, "1");
  if (!response || response.status !== 207) {
    return { count: 0, names: [] };
  }
  const doc = parseXml(response.body);
  const multistatus = isRecord(doc) ? doc.multistatus : undefined;
  const responses = toArray(isRecord(multistatus) ? multistatus.response : undefined);
  const wantedType = facet === "calendar" ? "calendar" : "addressbook";
  const normalizedHomeSet = homeSetUrl.replace(/\/+$/, "");

  const names: string[] = [];
  for (const entry of responses) {
    if (!isRecord(entry) || typeof entry.href !== "string") continue;
    const resolvedHref = new URL(entry.href, homeSetUrl).toString().replace(/\/+$/, "");
    if (resolvedHref === normalizedHomeSet) continue; // the home-set collection itself, not a child

    const prop = toArray(entry.propstat)
      .map((propstat) => (isRecord(propstat) ? propstat.prop : undefined))
      .find(isRecord);
    if (!prop || !isRecord(prop.resourcetype) || !(wantedType in prop.resourcetype)) continue;

    const displayname = prop.displayname;
    names.push(typeof displayname === "string" && displayname.trim() ? displayname : entry.href);
  }
  return { count: names.length, names };
}

async function propfind(
  deps: DavDiscoveryDeps,
  url: string,
  body: string,
  auth: string,
  depth: "0" | "1",
): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(url, {
      method: "PROPFIND",
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: depth,
        Authorization: auth,
      },
      body,
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

const PRINCIPAL_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`;

function homeSetPropfindBody(facet: DavFacet): string {
  if (facet === "calendar") {
    return `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
    <C:schedule-inbox-URL/>
    <C:schedule-outbox-URL/>
  </D:prop>
</D:propfind>`;
  }
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">
  <D:prop><CARD:addressbook-home-set/></D:prop>
</D:propfind>`;
}

function collectionPropfindBody(facet: DavFacet): string {
  const ns =
    facet === "calendar"
      ? `xmlns:C="urn:ietf:params:xml:ns:caldav"`
      : `xmlns:CARD="urn:ietf:params:xml:ns:carddav"`;
  return `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" ${ns}>
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
  </D:prop>
</D:propfind>`;
}

// --- namespace-tolerant multistatus parsing -------------------------------
//
// `removeNSPrefix` folds every server's own prefix choice ("D:", "d:",
// "cs:", none) down to the bare local tag name, so the property lookups
// above never key on a literal prefixed name a real server is free to pick
// differently.

function parseXml(xml: string): unknown {
  try {
    return new XMLParser({ ignoreAttributes: true, removeNSPrefix: true }).parse(xml);
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

/** Depth-first search for the first element anywhere in the parsed tree named `tag` (case-insensitive) — property nesting inside a `<prop>` varies enough between servers (and between the principal and home-set responses this module makes) that a fixed path isn't worth hand-coding twice over. */
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

function extractHref(xml: string, tag: string): string | null {
  const doc = parseXml(xml);
  const container = findTag(doc, tag);
  if (!isRecord(container)) return null;
  const href = container.href;
  return typeof href === "string" ? href : null;
}

function hasTag(xml: string, tag: string): boolean {
  const doc = parseXml(xml);
  return findTag(doc, tag) !== undefined;
}
