import type { FastifyReply } from "fastify";

export const SESSION_COOKIE = "mail_session";

/**
 * `secure` follows `PUBLIC_URL`'s scheme rather than `NODE_ENV`: ADR-0009
 * makes `PUBLIC_URL` the single source of truth for how the instance is
 * actually reached, and `trustProxy` means the app itself may still see
 * plain HTTP from an off-host reverse proxy.
 */
export function isSecureOrigin(publicUrl: string): boolean {
  return new URL(publicUrl).protocol === "https:";
}

export function setSessionCookie(
  reply: FastifyReply,
  publicUrl: string,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureOrigin(publicUrl),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, publicUrl: string) {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: isSecureOrigin(publicUrl),
    sameSite: "lax",
    path: "/",
  });
}
