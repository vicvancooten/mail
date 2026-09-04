import type { Recipient } from "@mail/shared";

/**
 * What a `mailto:` link (RFC 6068) hands the Composer (ADR-0018): one or
 * more recipients from the path, `subject`/`body` from the query string if
 * the sender's markup set them. Everything else RFC 6068 allows (`cc`,
 * `bcc`, arbitrary headers) is out of scope here — the click bridge exists
 * to open the Composer at all, not to give sender-authored markup a way to
 * set headers this app doesn't otherwise expose a control for.
 */
export interface MailtoLink {
  to: Recipient[];
  subject: string | null;
  body: string | null;
}

/** Parses a `mailto:` href from the click bridge; `null` for anything else (including a malformed `mailto:`). */
export function parseMailtoHref(href: string): MailtoLink | null {
  if (!href.toLowerCase().startsWith("mailto:")) return null;

  try {
    const url = new URL(href);
    // The WHATWG URL parser treats `mailto:` as an opaque-path scheme: the
    // address(es) sit in `pathname`, still percent-encoded exactly as the
    // sender wrote them.
    const to = decodeURIComponent(url.pathname)
      .split(",")
      .map((address) => address.trim())
      .filter((address) => address.length > 0)
      .map((address) => ({ address, name: null }));

    return { to, subject: url.searchParams.get("subject"), body: url.searchParams.get("body") };
  } catch {
    return null;
  }
}
