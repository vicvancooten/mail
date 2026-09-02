import type { MailAccountConnection, MailAccountSecurity } from "@mail/shared";
import { XMLParser } from "fast-xml-parser";

/**
 * Parses Mozilla's `config-v1.1.xml` autoconfig format (docs/research/0004
 * §1.2) — the same schema `autoconfig.<domain>`, `.well-known/autoconfig`,
 * and the Mozilla ISPDB all serve. Returns `null` on anything that isn't a
 * well-formed config with at least one usable `incomingServer type="imap"`
 * and `outgoingServer type="smtp"` — a redirect to a marketing page (as
 * privateemail.com's own subdomains do, per that research) parses to
 * nothing usable rather than throwing, so callers can just move on to the
 * next autodiscover step.
 */
export function parseAutoconfigXml(xml: string): {
  imap: MailAccountConnection;
  smtp: MailAccountConnection;
} | null {
  let doc: unknown;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
  } catch {
    return null;
  }

  const provider = get(doc, ["clientConfig", "emailProvider"]);
  if (!provider) {
    return null;
  }

  const imap = firstServer(provider, "incomingServer", "imap");
  const smtp = firstServer(provider, "outgoingServer", "smtp");
  if (!imap || !smtp) {
    return null;
  }
  return { imap, smtp };
}

/** `emailProvider` can be an array (multiple providers listed) or a single object. */
function firstServer(
  provider: unknown,
  tag: "incomingServer" | "outgoingServer",
  type: "imap" | "smtp",
): MailAccountConnection | null {
  const providers = Array.isArray(provider) ? provider : [provider];
  for (const entry of providers) {
    const servers = get(entry, [tag]);
    const list = Array.isArray(servers) ? servers : servers ? [servers] : [];
    for (const server of list) {
      if (!isRecord(server) || server["@_type"] !== type) {
        continue;
      }
      const connection = toConnection(server);
      if (connection) {
        return connection;
      }
    }
  }
  return null;
}

function toConnection(server: Record<string, unknown>): MailAccountConnection | null {
  const host = typeof server.hostname === "string" ? server.hostname.trim() : "";
  const port = Number(server.port);
  const security = toSecurity(server.socketType);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535 || !security) {
    return null;
  }
  return { host, port, security };
}

/** `config-v1.1.xml`'s `socketType`: `plain` | `SSL` | `STARTTLS` (docs/research/0004 §1.2). */
function toSecurity(socketType: unknown): MailAccountSecurity | null {
  if (typeof socketType !== "string") {
    return null;
  }
  switch (socketType.toUpperCase()) {
    case "SSL":
      return "tls";
    case "STARTTLS":
      return "starttls";
    case "PLAIN":
      return "none";
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function get(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}
