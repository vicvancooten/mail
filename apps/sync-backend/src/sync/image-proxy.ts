import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/**
 * Remote-image handling for the reading pane (#41, `docs/research/0005` §3).
 *
 * The **default-blocked** decision itself lives entirely on the Client: a
 * message body is delivered with every remote `<img>`/`background-image`
 * reference already rewritten to a signed same-origin proxy URL, and
 * whether that URL is actually the live `src` (vs. a same-document
 * placeholder) is a render-time choice `MessageBody.tsx` makes per message,
 * per open. This module only has to guarantee two things once a fetch does
 * happen: the sender never sees the viewer's IP (a real server-to-server
 * fetch, not a client-side one), and the proxy cannot be turned into an
 * open relay by a tampered URL (`ALLOWED_URI_REGEXP`/query string) — hence
 * the HMAC over `(messageId, url)`.
 *
 * The Approved-Sender verdict (`docs/research/0005`'s "gated live on the
 * Approved-Sender verdict") landed with Gatekeeper (#55) — as the *default*
 * the reading pane opens with, carried per message on
 * `Message.remoteImagesAllowed` (`routes/messages.ts`), not as a rule this
 * proxy enforces. This proxy still fetches whatever a validly-signed request
 * asks for, deliberately: the manual per-message "load images" override has
 * to keep working for an Unscreened sender, and a signature the Client can
 * only have obtained from a body it was served is not the place to
 * re-litigate a decision the User just made by clicking the button.
 */

/** Derived from the same instance-held secret credentials are sealed under (ADR-0003), a different HKDF-style label so a leak of one key says nothing about the other. */
export function deriveImageProxyKey(mailCredentialKey: string): Buffer {
  return createHash("sha256").update(`image-proxy:${mailCredentialKey}`, "utf8").digest();
}

/**
 * How long a signed image-proxy URL stays valid (ADR-0018: "signed,
 * expiring, session-free image URLs"). Rewritten on every serve
 * (`rewriteRemoteImageReferences` runs at read time, not ingest), so this
 * only has to outlast one render of the reading pane, not the message's
 * whole lifetime — a User re-opening the same Thread later gets a freshly
 * signed URL regardless.
 */
export const IMAGE_PROXY_TTL_MS = 60 * 60 * 1000;

function signature(key: Buffer, messageId: string, url: string, expiresAt: number): string {
  return createHmac("sha256", key)
    .update(`${messageId}:${url}:${expiresAt}`, "utf8")
    .digest("base64url");
}

/** The path a rewritten `<img src>`/`url()` reference points at. */
export function buildImageProxyPath(
  key: Buffer,
  messageId: string,
  url: string,
  now: number = Date.now(),
): string {
  const expiresAt = now + IMAGE_PROXY_TTL_MS;
  const sig = signature(key, messageId, url, expiresAt);
  const query = new URLSearchParams({ url, exp: String(expiresAt), sig });
  return `/messages/${encodeURIComponent(messageId)}/image-proxy?${query.toString()}`;
}

/**
 * Constant-time signature check — a byte-by-byte `===` would leak timing
 * information about how many leading bytes matched, letting an attacker
 * forge a valid `sig` for an arbitrary `url` one byte at a time. The expiry
 * itself is checked in plain time (there's nothing secret about "is this
 * number in the past") before the signature is even computed, so an
 * expired-but-otherwise-genuine URL 403s without needing HMAC math at all.
 */
export function verifyImageProxySignature(
  key: Buffer,
  messageId: string,
  url: string,
  sig: string,
  expiresAt: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(signature(key, messageId, url, expiresAt), "utf8");
  const actual = Buffer.from(sig, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Matches an `<img ...src="http(s)://...">` attribute value inside already-sanitized HTML. */
const REMOTE_IMG_SRC = /(<img\b[^>]*\bsrc=")(https?:\/\/[^"]*)(")/gi;
/** Matches a CSS `url(http(s)://...)` reference inside a `style` attribute or `<style>` block. */
const REMOTE_CSS_URL = /url\(\s*(['"]?)(https?:\/\/[^)'"]*)\1\s*\)/gi;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * The inverse, and load-bearing rather than cosmetic: the two patterns above
 * match against *serialized* HTML (`sanitize.ts`'s output), where an
 * attribute value has already been escaped — so a perfectly ordinary
 * tracking URL arrives here as
 * `https://cdn.example/px.gif?id=42&amp;u=abc`. Signing and fetching that
 * verbatim asks the upstream for query parameters literally named `amp;u`,
 * which is a 400/404 from anything that reads its own query string: every
 * remote image with more than one parameter — most of them, in real mail —
 * failed to load. Only the entities an HTML serializer actually emits are
 * decoded; the URL is re-escaped on the way back out.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Rewrites every remaining remote image reference in already-sanitized HTML
 * to a signed same-origin proxy path (`docs/research/0005`'s recommended
 * pipeline, step 3). Runs at **serve time** (`routes/messages.ts`), not
 * ingest: `sync/sanitize.ts` deliberately leaves remote `src`/`url()` values
 * alone (see its own docstring), so every message — synced before this
 * ticket existed or after — gets a consistently rewritten body on every
 * read, with no backfill job required.
 *
 * `cid:`, `data:` and already-proxied references are left untouched: `cid:`
 * resolution is the Client's job (§4), and nothing here should double-sign
 * an already-signed path.
 */
export function rewriteRemoteImageReferences(
  html: string,
  { messageId, key }: { messageId: string; key: Buffer },
): string {
  const withImg = html.replace(REMOTE_IMG_SRC, (_match, pre: string, url: string, post: string) => {
    const proxied = buildImageProxyPath(key, messageId, decodeEntities(url));
    return `${pre}${escapeAttr(proxied)}${post}`;
  });
  return withImg.replace(REMOTE_CSS_URL, (_match, quote: string, url: string) => {
    const proxied = buildImageProxyPath(key, messageId, decodeEntities(url));
    return `url(${quote}${proxied}${quote})`;
  });
}

// ---------------------------------------------------------------------------
// SSRF-safe upstream fetch (OWASP SSRF Prevention Cheat Sheet, cited in
// docs/research/0005 §3): allowlist scheme, resolve and validate every
// address at *connection* time (closes the DNS-rebinding gap a hostname-only
// check leaves open), pin the connection to the validated address, and cap
// both time and size spent on an upstream that may be hostile or simply
// slow.
// ---------------------------------------------------------------------------

export class ImageProxyError extends Error {
  constructor(
    readonly code:
      | "invalid_url"
      | "disallowed_scheme"
      | "disallowed_address"
      | "too_large"
      | "upstream_error"
      | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "ImageProxyError";
  }
}

const MAX_IMAGE_BYTES = 10_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** RFC 1918 + loopback + link-local + the cloud-metadata address, per the cheat sheet's own list. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // malformed — refuse, don't guess
  if (a === undefined || b === undefined) return true;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast/reserved
  return false;
}

/** Loopback, unique-local (`fc00::/7`) and link-local (`fe80::/10`) — the IPv6 equivalents. */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped — validate the embedded v4 address instead of waving it through.
    return isPrivateIPv4(normalized.slice("::ffff:".length));
  }
  const firstGroup = normalized.split(":")[0] ?? "";
  const firstByte = Number.parseInt(firstGroup.padStart(4, "0").slice(0, 2), 16);
  if (!Number.isNaN(firstByte) && firstByte >= 0xfc && firstByte <= 0xfd) return true; // fc00::/7
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) return true; // fe80::/10 (approx.)
  if (normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  return false;
}

export function isPrivateOrReservedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not a literal IP at all — refuse rather than guess
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Both shapes Node's `lookup` request option can be called back with — the
 * plain one, and the `{ all: true }` one `net.createConnection` uses while
 * `autoSelectFamily` is on (its default). `fetchOnce` below answers whichever
 * the caller asked for; see its own comment for what answering only the first
 * one cost.
 */
type LookupCallback = ((err: null, address: string, family: number) => void) &
  ((err: null, addresses: { address: string; family: number }[]) => void);

/** Injectable so tests never need real DNS. Node's `dns.lookup` by default, `{ all: true }`. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
}

/**
 * Resolves a hostname and picks the first address that is not
 * loopback/private/link-local/metadata. Every candidate address is checked —
 * not just the one ultimately used — so a hostname that resolves to *both* a
 * public and a private address (a classic rebinding shape) still refuses,
 * rather than racing which answer wins.
 */
export async function resolveSafeAddress(
  hostname: string,
  resolve: Resolver = defaultResolver,
): Promise<ResolvedAddress> {
  const literalVersion = isIP(hostname);
  const candidates =
    literalVersion !== 0
      ? [{ address: hostname, family: literalVersion as 4 | 6 }]
      : await resolve(hostname);

  if (candidates.length === 0) {
    throw new ImageProxyError("disallowed_address", `${hostname} did not resolve to any address`);
  }
  for (const candidate of candidates) {
    if (isPrivateOrReservedAddress(candidate.address)) {
      throw new ImageProxyError(
        "disallowed_address",
        `${hostname} resolves to a private/reserved address (${candidate.address})`,
      );
    }
  }
  const first = candidates[0];
  if (!first) {
    throw new ImageProxyError("disallowed_address", `${hostname} did not resolve to any address`);
  }
  return first;
}

export interface ProxiedImage {
  kind: "ok";
  body: Buffer;
  contentType: string;
}

export interface FetchProxiedImageOptions {
  resolve?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Fetches one upstream image URL through the SSRF-safe path above, pinning
 * the outbound connection to the address that was actually validated
 * (Node's `fetch` resolves lazily, so validating the hostname and then
 * calling `fetch(url)` unpinned would still leave the rebinding gap open —
 * `dispatcher`/`connect.lookup` here is what closes it, per undici's
 * documented connect-time hook). Redirects are followed manually, capped,
 * and re-validated at every hop for the same reason a single check at the
 * top is not enough.
 */
export async function fetchProxiedImage(
  url: string,
  {
    resolve,
    maxBytes = MAX_IMAGE_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
  }: FetchProxiedImageOptions = {},
): Promise<ProxiedImage> {
  let target = url;
  for (let hop = 0; ; hop += 1) {
    if (hop > MAX_REDIRECTS) {
      throw new ImageProxyError("upstream_error", "too many redirects");
    }
    const parsed = parseHttpUrl(target);
    const resolved = await resolveSafeAddress(parsed.hostname, resolve);
    const result = await fetchOnce(parsed, resolved, { maxBytes, timeoutMs });
    if (result.kind === "redirect") {
      target = result.location;
      continue;
    }
    return { kind: "ok", body: result.body, contentType: result.contentType };
  }
}

function parseHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageProxyError("invalid_url", `not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImageProxyError("disallowed_scheme", `scheme not allowed: ${parsed.protocol}`);
  }
  return parsed;
}

export type FetchOnceResult = ProxiedImage | { kind: "redirect"; location: string };

/**
 * One connection, pinned to `resolved.address` via Node's own `lookup`
 * request option (`http.request`/`https.request` both hand it straight to
 * the underlying `net.createConnection`/`tls.connect`) so the TCP handshake
 * — not just the DNS question — lands on the validated IP, no extra
 * dependency required. `servername` (TLS SNI) is left as the original
 * hostname so a virtual-hosted/TLS-terminated upstream still presents the
 * right certificate.
 *
 * Exported (only `fetchProxiedImage`/`resolveSafeAddress` are the real
 * public surface) so tests can exercise the streaming/redirect/size-cap
 * mechanics against a local server directly — `resolveSafeAddress` refuses
 * every loopback/private address by design, which is correct in production
 * and otherwise unfalsifiable in a sandboxed test run with no outbound
 * internet.
 */
export function fetchOnce(
  url: URL,
  resolved: ResolvedAddress,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
): Promise<FetchOnceResult> {
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  return new Promise<FetchOnceResult>((resolvePromise, reject) => {
    const req = requestFn(
      {
        method: "GET",
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        headers: { "user-agent": "MailImageProxy/1.0" },
        timeout: timeoutMs,
        servername: url.protocol === "https:" ? url.hostname : undefined,
        // Overrides *only* the connect-time address resolution — every
        // other option (`hostname`, `servername`, the `Host` header Node
        // derives from `hostname`) still reflects the sender's original
        // URL, which is what a virtual-hosted upstream and TLS both need.
        //
        // Both callback shapes are answered, keyed off `options.all`, and
        // that is load-bearing rather than defensive: `autoSelectFamily`
        // defaults to **true** on the Node this runs on (22; confirmed with
        // `net.getDefaultAutoSelectFamily()`), so `net.createConnection`
        // calls this with `{ hints, all: true }` and expects
        // `callback(null, addresses[])`. Answering that with the
        // three-argument form left `net` holding `addresses === undefined`
        // and every single upstream fetch failed on `Invalid IP address:
        // undefined` — a 502 from this route for every remote image in
        // every message, which is exactly what "Image failed to load"
        // reported.
        lookup: ((_hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
          if (options?.all) {
            callback(null, [{ address: resolved.address, family: resolved.family }]);
            return;
          }
          callback(null, resolved.address, resolved.family);
          // eslint-disable-next-line -- see the type's own comment
        }) as never,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.resume(); // discard the redirect body without buffering it
          if (!location) {
            reject(new ImageProxyError("upstream_error", `redirect with no Location (${status})`));
            return;
          }
          try {
            resolvePromise({ kind: "redirect", location: new URL(location, url).toString() });
          } catch {
            reject(new ImageProxyError("upstream_error", `redirect Location is not a valid URL`));
          }
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new ImageProxyError("upstream_error", `upstream responded ${status}`));
          return;
        }

        const contentLength = res.headers["content-length"];
        if (contentLength && Number(contentLength) > maxBytes) {
          res.resume();
          reject(
            new ImageProxyError("too_large", `Content-Length ${contentLength} exceeds ${maxBytes}`),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            req.destroy();
            reject(new ImageProxyError("too_large", `body exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolvePromise({
            kind: "ok",
            body: Buffer.concat(chunks),
            contentType: res.headers["content-type"] ?? "application/octet-stream",
          });
        });
        res.on("error", (err) => reject(new ImageProxyError("upstream_error", err.message)));
      },
    );

    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err: Error) => {
      if (err.message === "timeout") {
        reject(new ImageProxyError("timeout", `upstream fetch exceeded ${timeoutMs}ms`));
      } else {
        reject(new ImageProxyError("upstream_error", err.message));
      }
    });
    req.end();
  });
}
