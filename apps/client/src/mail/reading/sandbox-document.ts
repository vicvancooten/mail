import DOMPurify from "dompurify";
import { decodeCidReference } from "./cid.js";

/**
 * The Client's half of the two-pass sanitize (#41, `docs/research/0005` §1):
 * DOMPurify, in the real browser DOM, run again immediately before the
 * sandboxed `srcdoc` write. The server already sanitized this same body at
 * ingest (`sync/sanitize.ts`) — this pass is what makes a future DOMPurify
 * security release protect the entire historical local cache the next time
 * each message is opened, not only newly-ingested mail.
 *
 * The allowlist mirrors the server's (`sync/sanitize.ts`'s `ALLOWED_TAGS`/
 * `ALLOWED_ATTRIBUTES`) on purpose: the two passes are independent gates
 * against different bug classes (a jsdom-hosted quirk server-side vs. a
 * real-browser-DOM edge case here), not one delegating to the other.
 */
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
];

const ALLOWED_ATTR = [
  "align",
  "alt",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "color",
  "colspan",
  "dir",
  "face",
  "height",
  "hspace",
  "id",
  "lang",
  "rowspan",
  "size",
  "span",
  "style",
  "title",
  "valign",
  "vspace",
  "width",
  "href",
  "name",
  "rel",
  "target",
  "src",
  "datetime",
];

/**
 * `blob:` (resolved `cid:` images) and `data:` (the "remote image not yet
 * loaded" placeholder pixel) join the server's own `https`/`mailto`/`tel`/
 * `cid` allowlist — DOMPurify's *default* `ALLOWED_URI_REGEXP` excludes both,
 * which would otherwise strip the exact substitutions this module makes
 * (`docs/research/0005` §4's own callout).
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:https|mailto|tel|cid|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/** A fully transparent 1x1 GIF — what a not-yet-loaded remote image's `src` points at instead of fetching anything. */
export const BLOCKED_IMAGE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function isProxiedImageUrl(url: string): boolean {
  return url.includes("/image-proxy?");
}

export interface ImageReferenceState {
  /** `Content-ID` (RFC 2392, brackets off) → `blob:` URL, from `resolveCidBlobs`. */
  cidBlobUrls: ReadonlyMap<string, string>;
  /** Whether this render should show remote images (the per-message "load images" override) or block them by default. */
  imagesLoaded: boolean;
}

/**
 * DOMPurify's own threat model stops at markup — it does **not** filter CSS
 * content (`docs/research/0005` §1's own callout: "DOMPurify does not
 * sanitize CSS by default"). This is the same denylist
 * `sync/sanitize.ts#sanitizeCss` (sync-backend) already applies at ingest,
 * reapplied here so the two passes are genuinely independent gates against
 * the same bug class, not one silently trusting the other already ran.
 */
const DANGEROUS_CSS = /(expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|vbscript\s*:)/gi;

function sanitizeCssText(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/@(?:import|charset|namespace)[^;{}]*;?/gi, " ")
    .replace(DANGEROUS_CSS, "blocked:");
}

function rewriteCssUrls(css: string, state: ImageReferenceState): string {
  return sanitizeCssText(css).replace(
    /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi,
    (match, quote: string, url: string) => {
      if (url.startsWith("cid:")) {
        const blobUrl = state.cidBlobUrls.get(decodeCidReference(url));
        return blobUrl ? `url(${quote}${blobUrl}${quote})` : "url(about:blank)";
      }
      if (isProxiedImageUrl(url)) {
        return state.imagesLoaded ? match : "url(about:blank)";
      }
      return match;
    },
  );
}

/**
 * Runs the client-side sanitize pass and substitutes every image reference
 * for this render: `cid:` → `blob:` where resolved (a broken-image
 * placeholder otherwise — never a network request), and a proxied remote
 * reference → either left as-is (opted in) or replaced with a same-document
 * transparent pixel (blocked, the default).
 *
 * The input is wrapped in a `<div>` before sanitizing and unwrapped after:
 * DOMPurify (confirmed against this project's own jsdom-hosted tests, not
 * merely suspected) silently drops a bare `<style>` element when it is the
 * very first top-level node of the sanitized fragment — an HTML
 * fragment-parsing quirk around `<style>`'s "in head" insertion mode, not
 * anything specific to this project's config. A wrapping element makes
 * `<style>` never the top-level node, which is reliable regardless of root
 * cause and costs nothing (the wrapper itself is discarded before this
 * function returns).
 */
export function sanitizeAndSubstitute(html: string, state: ImageReferenceState): string {
  const fragment = DOMPurify.sanitize(`<div>${html}</div>`, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;

  const wrapper = fragment.firstElementChild;
  if (!wrapper) return "";

  for (const img of wrapper.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    if (src.startsWith("cid:")) {
      const blobUrl = state.cidBlobUrls.get(decodeCidReference(src));
      if (blobUrl) img.setAttribute("src", blobUrl);
      else img.removeAttribute("src");
    } else if (isProxiedImageUrl(src) && !state.imagesLoaded) {
      img.setAttribute("src", BLOCKED_IMAGE_PLACEHOLDER);
    }
  }

  for (const el of wrapper.querySelectorAll("[style]")) {
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", rewriteCssUrls(style, state));
  }
  for (const styleEl of wrapper.querySelectorAll("style")) {
    if (styleEl.textContent) styleEl.textContent = rewriteCssUrls(styleEl.textContent, state);
  }

  return wrapper.innerHTML;
}

/** Whether the body carries any reference this render would proxy — the "Load remote images" button only shows when there's something to load. */
export function hasProxiedImages(html: string): boolean {
  return html.includes("/image-proxy?");
}

/**
 * Apple Mail's own documented signal (`docs/research/0005` §6, the WebKit
 * blog): a sender who declares `color-scheme` opts out of the auto-darkening
 * transform. Only the CSS-property form can ever reach this check — a
 * `<meta name="color-scheme">` tag is stripped at ingest (`meta` is absent
 * from `sync/sanitize.ts`'s `ALLOWED_TAGS`), so the CSS form is the only one
 * this pipeline can honor.
 */
export function senderDeclaresColorScheme(html: string): boolean {
  return /color-scheme\s*:/i.test(html);
}

const CSP_DIRECTIVES = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
];

/**
 * The strict per-render CSP (`docs/research/0005` §2). `img-src` names the
 * app's real origin explicitly, never `'self'`: the sandboxed document's own
 * origin is opaque (no `allow-same-origin`), so `'self'` inside it matches
 * nothing and the image proxy would silently stop working.
 */
export function buildMessageCsp({ nonce, origin }: { nonce: string; origin: string }): string {
  return [...CSP_DIRECTIVES, `img-src ${origin} data: blob:`, `script-src 'nonce-${nonce}'`].join(
    "; ",
  );
}

/**
 * `ResizeObserver` + `postMessage` sizing (`docs/research/0005` §5): the one
 * script this sandboxed document runs, gated by the per-render nonce so a
 * sanitizer failure alone can never make sender-authored markup execute
 * alongside it — CSP is the independent second gate. Posts on every observed
 * change plus once eagerly, so the parent paints a real height even if
 * layout was already stable before the first callback fires.
 */
const RESIZE_SCRIPT = `(function(){
function post(){parent.postMessage({type:"mail-body-resize",height:document.documentElement.scrollHeight},"*");}
new ResizeObserver(post).observe(document.body);
post();
})();`;

export interface MessageDocumentOptions {
  /** Server-sanitized body HTML, already proxy-rewritten for remote images (`sync/image-proxy.ts`), `cid:` untouched. */
  html: string;
  cidBlobUrls: ReadonlyMap<string, string>;
  imagesLoaded: boolean;
  darkMode: boolean;
  nonce: string;
  origin: string;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Builds the full sandboxed `srcdoc` document (#41's `MessageBody` writes this into an `iframe sandbox="allow-scripts"`). */
export function buildMessageDocument(opts: MessageDocumentOptions): string {
  const state: ImageReferenceState = {
    cidBlobUrls: opts.cidBlobUrls,
    imagesLoaded: opts.imagesLoaded,
  };
  const body = sanitizeAndSubstitute(opts.html, state);
  const invert = opts.darkMode && !senderDeclaresColorScheme(opts.html);
  const csp = buildMessageCsp({ nonce: opts.nonce, origin: opts.origin });

  const invertCss = invert
    ? `.mail-invert{filter:invert(1) hue-rotate(180deg);background:#fff;}
.mail-invert img,.mail-invert video,.mail-invert svg,.mail-invert picture{filter:invert(1) hue-rotate(180deg);}`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">
<style>
html,body{margin:0;padding:8px 12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-size:14px;color:#111;background:#fff;word-wrap:break-word;overflow-wrap:anywhere;}
img{max-width:100%;height:auto;}
table{max-width:100%;}
${invertCss}
</style>
</head><body>
<div${invert ? ' class="mail-invert"' : ""}>${body}</div>
<script nonce="${opts.nonce}">${RESIZE_SCRIPT}</script>
</body></html>`;
}
