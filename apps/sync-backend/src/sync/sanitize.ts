import sanitizeHtml from "sanitize-html";

/**
 * Server-side sanitization at ingest (`docs/research/0005` §1, poc-spec.md
 * §Reading). Raw sender HTML is **never** written to `messages.body_html`;
 * only the output of this function is, so every downstream consumer of a
 * stored body — the Client's Local Cache, the Search Index, a notification
 * Snippet — inherits one cleaning pass it cannot forget to run.
 *
 * This is the *first* of the two passes the research settles on. The Client
 * sanitizes again immediately before DOM insertion, inside a `sandbox`ed
 * iframe under a strict CSP; that second pass is what makes a future
 * sanitizer CVE fix protect the already-cached historical corpus. Neither
 * pass is redundant, and this one is not allowed to be the only one.
 *
 * The tag/attribute policy is an allowlist, per the consensus the research
 * records: anything not named here is discarded, rather than denied case by
 * case.
 */

/** Whitespace-separated so a ~70-entry allowlist stays one readable block. */
function tokens(list: string): string[] {
  return list.trim().split(/\s+/);
}

/**
 * Structural, inline-formatting and table markup, plus the legacy tags
 * (`font`, `center`) real mail is still full of. Notably absent: `script`,
 * `iframe`, `object`, `embed`, `applet`, `form` and every form control,
 * `base`, `link`, `meta`, `svg`, `math`, `audio`, `video`, `template`,
 * `noscript`.
 */
const ALLOWED_TAGS = tokens(`
  a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup
  dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img
  ins kbd li main mark nav ol p pre q s samp section small span strike strong style sub summary sup
  table tbody td tfoot th thead time tr tt u ul var wbr
`);

/**
 * Presentational attributes email actually depends on. `style` survives —
 * mail HTML is inline-styled by construction — but every value routes
 * through `sanitizeCss` before it is emitted. Event handlers (`on*`) are
 * absent, which is what makes them impossible to smuggle through.
 */
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  "*": tokens(`
    align alt bgcolor border cellpadding cellspacing class color colspan dir face height hspace id
    lang rowspan size span style title valign vspace width
  `),
  a: ["href", "name", "rel", "target"],
  img: ["src"],
  time: ["datetime"],
};

/**
 * Exactly the schemes `docs/research/0005` names for the ingest sanitizer:
 * `https`, `mailto`, `tel`, `cid`. `http` is deliberately absent — a plain
 * `http:` href or image is an unauthenticated fetch, and the research's
 * pipeline routes remote images through the backend proxy regardless. A
 * dropped `href` leaves the link *text* in place rather than deleting
 * content, so nothing a sender wrote disappears.
 */
const ALLOWED_SCHEMES = ["https", "mailto", "tel", "cid"];

/** CSS constructs that fetch, execute, or reach outside the rendered document. */
const DANGEROUS_CSS = /(expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|vbscript\s*:)/gi;
/** Schemes a CSS `url()` may keep. Everything else is replaced. */
const SAFE_CSS_URL = /^(?:https:|cid:|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i;
/** A style blob past this is a rendering hazard, not styling; mail this large is broken. */
const MAX_CSS_LENGTH = 100_000;

/**
 * Filters a CSS fragment — a `style` attribute's value, or the body of a
 * `<style>` block.
 *
 * `<style>` is kept rather than dropped: dropping it at *ingest* is
 * irreversible for the stored corpus and wrecks the rendering of ordinary
 * marketing mail. What is removed is the part that can act — comments (which
 * hide the rest from a casual reader), `@import` (a fetch), the
 * scripting-adjacent legacy properties, and any `url()` that is not already
 * an `https:`, `cid:` or inline-image reference.
 *
 * This is a denylist inside an allowlisted tag, so it is explicitly *not*
 * the guarantee. The guarantee is the render-time regime research §2
 * specifies: `default-src 'none'` and a sandbox without `allow-scripts`.
 */
export function sanitizeCss(css: string): string {
  if (css.length > MAX_CSS_LENGTH) return "";
  return css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/@(?:import|charset|namespace)[^;{}]*;?/gi, " ")
    .replace(DANGEROUS_CSS, "blocked:")
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _quote: string, url: string) =>
      SAFE_CSS_URL.test(url.trim()) ? match : "url(about:blank)",
    )
    .replace(/\s+/g, " ")
    .trim();
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: ALLOWED_SCHEMES,
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  // A `//host/x` src inherits whatever scheme the renderer runs under; the
  // sandboxed iframe's origin is opaque, so this is never anything but a
  // way past a scheme allowlist.
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // sanitize-html's default discards the *text* of these outright, so a
  // stripped `<script>` can never leak its source as body text. `style` is
  // off the list because its content is kept, filtered, below.
  nonTextTags: ["script", "textarea", "option", "noscript"],
  // `style` is on `allowedTags` on purpose (see `sanitizeCss`). This
  // acknowledges sanitize-html's warning about it rather than tripping it.
  allowVulnerableTags: true,
  // One handler for every tag: sanitize-html picks a tag-specific transform
  // over `"*"` when both exist, so anchors and style attributes have to be
  // handled together or one of the two silently stops being filtered.
  transformTags: {
    "*": (tagName, attribs) => {
      const next: Record<string, string> = { ...attribs };
      if (next.style !== undefined) {
        const safe = sanitizeCss(next.style);
        if (safe) {
          next.style = safe;
        } else {
          delete next.style;
        }
      }
      if (tagName === "a" && next.href) {
        // Mail links always leave the app, and whatever the sender links to
        // must not get a handle on the opener.
        next.target = "_blank";
        next.rel = "noopener noreferrer nofollow";
      }
      return { tagName, attribs: next };
    },
  },
};

/**
 * `<style>` block bodies are the one thing sanitize-html passes through
 * verbatim — it neither escapes nor filters them — so they are filtered
 * here, after the parse, against the same `sanitizeCss` the attributes went
 * through.
 */
const STYLE_BLOCK = /<style([^>]*)>([\s\S]*?)<\/style>/gi;

/**
 * Sanitizes one message's HTML body for storage. Returns `""` for empty
 * input, so a caller never has to distinguish "no body" from "a body that
 * sanitized down to nothing".
 *
 * Remote `<img src>` values are left as-is: rewriting them to the signed
 * image-proxy URL is the *rendering* ticket's job (research §Recommended
 * pipeline, step 3) and needs a Gatekeeper verdict this ticket has no table
 * for yet. Nothing renders a stored body before that rewrite lands.
 */
export function sanitizeMessageHtml(html: string | null | undefined): string {
  if (!html) return "";
  return sanitizeHtml(html, OPTIONS).replace(
    STYLE_BLOCK,
    (_match, attributes: string, css: string) => {
      const safe = sanitizeCss(css);
      return safe ? `<style${attributes}>${safe}</style>` : "";
    },
  );
}
