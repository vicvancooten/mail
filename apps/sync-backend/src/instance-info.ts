/**
 * Facts about this running instance (#104), computed once and shared
 * between the two places that quote them: the boot-time log warnings
 * (`main.ts`) and the Owner-only Instance page's route (`routes/instance.ts`).
 * They must never drift, since the whole point of the page is "the Owner
 * learns from logs and the Instance page" (grill Q21/Q32) — the same fact,
 * the same wording, either way they find it.
 */

/** Shipped in the image as `/usr/local/bin/mail` (see the repo-root `Dockerfile`). */
export const GENERATE_VAPID_KEYS_COMMAND = "mail generate-vapid-keys";

/** The same value `/healthz` (`routes/health.ts`) reports. */
export function getAppVersion(): string {
  return process.env.npm_package_version ?? "0.0.0";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * True when `publicUrl` is a context Web Push and WebAuthn can actually
 * work from: `https:`, or a loopback host only ever reachable from the
 * machine running the instance itself. `http://` on any other host is the
 * case the boot warning and the Instance page both call out — "push and
 * passkeys will not work from other devices".
 */
export function isSecureContext(publicUrl: string): boolean {
  try {
    const url = new URL(publicUrl);
    return url.protocol === "https:" || LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
