import { resolveMx as dnsResolveMx, resolveSrv as dnsResolveSrv } from "node:dns/promises";
import type { AutodiscoverSource, MailAccountConnection } from "@mail/shared";
import { parseAutoconfigXml } from "./autoconfig-xml.js";

/** "A few seconds," per-attempt, per docs/research/0004 §4 — no spec mandates an exact value. */
const STEP_TIMEOUT_MS = 4000;

export type DiscoverMailAccountResult =
  | {
      found: true;
      source: AutodiscoverSource;
      imap: MailAccountConnection;
      smtp: MailAccountConnection;
    }
  | { found: false; prefill: { imap: MailAccountConnection; smtp: MailAccountConnection } | null };

/** privateemail's own documented, stable defaults (docs/research/0004 §4). */
const PRIVATEEMAIL_PREFILL: { imap: MailAccountConnection; smtp: MailAccountConnection } = {
  imap: { host: "mail.privateemail.com", port: 993, security: "tls" },
  smtp: { host: "mail.privateemail.com", port: 587, security: "starttls" },
};

const PRIVATEEMAIL_MX = /^mx[12]\.privateemail\.com\.?$/i;

export interface AutodiscoverDeps {
  fetchImpl: typeof fetch;
  resolveSrv: typeof dnsResolveSrv;
  resolveMx: typeof dnsResolveMx;
}

const defaultDeps: AutodiscoverDeps = {
  fetchImpl: fetch,
  resolveSrv: dnsResolveSrv,
  resolveMx: dnsResolveMx,
};

/**
 * The autodiscover chain, in the order poc-spec.md §Mail Accounts fixes:
 * `autoconfig.<domain>` → `.well-known/autoconfig` → RFC 6186 SRV → Mozilla
 * ISPDB → manual entry. Each step is tried only if the previous produced no
 * structured answer at all (docs/research/0004 §2's rule); `deps` is
 * injectable so tests don't need real DNS/HTTP.
 */
export async function discoverMailAccount(
  emailAddress: string,
  deps: AutodiscoverDeps = defaultDeps,
): Promise<DiscoverMailAccountResult> {
  const domain = emailAddress.split("@")[1]?.toLowerCase().trim();
  if (!domain) {
    throw new Error(`discoverMailAccount received an address with no domain: ${emailAddress}`);
  }

  const autoconfig = await tryAutoconfigXml(
    deps,
    `autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(emailAddress)}`,
  );
  if (autoconfig) {
    return { found: true, source: "autoconfig", ...autoconfig };
  }

  const wellKnown = await tryAutoconfigXml(
    deps,
    `${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(emailAddress)}`,
  );
  if (wellKnown) {
    return { found: true, source: "well-known", ...wellKnown };
  }

  const srv = await trySrv(deps, domain);
  if (srv) {
    return { found: true, source: "srv", ...srv };
  }

  const ispdb = await tryFetchXml(deps, `https://autoconfig.thunderbird.net/v1.1/${domain}`);
  if (ispdb) {
    return { found: true, source: "ispdb", ...ispdb };
  }

  return {
    found: false,
    prefill: (await isPrivateEmailDomain(deps, domain)) ? PRIVATEEMAIL_PREFILL : null,
  };
}

/** Tries HTTPS first, then plain HTTP — same parser either way, per docs/research/0004 §1.2. */
async function tryAutoconfigXml(deps: AutodiscoverDeps, hostAndPath: string) {
  return (
    (await tryFetchXml(deps, `https://${hostAndPath}`)) ??
    (await tryFetchXml(deps, `http://${hostAndPath}`))
  );
}

async function tryFetchXml(deps: AutodiscoverDeps, url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const body = await response.text();
    return parseAutoconfigXml(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * RFC 6186 (docs/research/0004 §1.1): TLS-first services tried before their
 * STARTTLS-or-plain counterparts, lowest SRV priority wins, and a target of
 * `.` means "explicitly absent" rather than a lookup failure.
 */
async function trySrv(deps: AutodiscoverDeps, domain: string) {
  const imap =
    (await lookupSrv(deps, `_imaps._tcp.${domain}`, "tls")) ??
    (await lookupSrv(deps, `_imap._tcp.${domain}`, "starttls"));
  const smtp =
    (await lookupSrv(deps, `_submission._tcp.${domain}`, "starttls")) ??
    (await lookupSrv(deps, `_pop3s._tcp.${domain}`, "tls")) ??
    (await lookupSrv(deps, `_pop3._tcp.${domain}`, "starttls"));
  if (!imap || !smtp) {
    return null;
  }
  return { imap, smtp };
}

async function lookupSrv(
  deps: AutodiscoverDeps,
  name: string,
  security: MailAccountConnection["security"],
): Promise<MailAccountConnection | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const records = await Promise.race([
      deps.resolveSrv(name),
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
    return { host: best.name, port: best.port, security };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function isPrivateEmailDomain(deps: AutodiscoverDeps, domain: string): Promise<boolean> {
  try {
    const records = await deps.resolveMx(domain);
    return records.some((record) => PRIVATEEMAIL_MX.test(record.exchange));
  } catch {
    return false;
  }
}
