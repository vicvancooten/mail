import { z } from "zod";

/**
 * How a User can authenticate. Password is the only one implemented at PoC;
 * TOTP (second factor) and passkeys (alternate primary) bolt on in #32, OIDC
 * later — this union is the wire-level half of the `AuthMethod` seam so
 * adding one never reshapes `User` or the session response.
 */
export const authMethodTypeSchema = z.enum(["password", "totp", "passkey", "oidc"]);
export type AuthMethodType = z.infer<typeof authMethodTypeSchema>;

export const userRoleSchema = z.enum(["owner", "member"]);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Never carries the password hash — that never crosses the wire. */
export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: userRoleSchema,
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(64, "Username must be at most 64 characters")
  .regex(/^[a-zA-Z0-9._-]+$/, "Username may only contain letters, numbers, . _ -");

/** Shared with the operator CLI's password-reset escape hatch. */
export const passwordSchema = z.string().min(8, "Password must be at least 8 characters");

export const authStatusResponseSchema = z.object({
  /** False only until the one-time claim token creates the Owner. */
  claimed: z.boolean(),
});
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;

export const claimRequestSchema = z.object({
  token: z.string().min(1),
  username: usernameSchema,
  password: passwordSchema,
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionResponseSchema = z.object({
  user: userSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * What `/auth/login` and `/auth/passkeys/login/verify` return when the User
 * has a confirmed TOTP enrollment: the primary method succeeded, but a
 * session isn't minted until `/auth/login/totp` redeems this challenge
 * (#32) — TOTP is a second factor checked after a `PrimaryAuthMethod`
 * succeeds, never an alternative to one.
 */
export const totpChallengeResponseSchema = z.object({
  totpRequired: z.literal(true),
  challengeToken: z.string(),
});
export type TotpChallengeResponse = z.infer<typeof totpChallengeResponseSchema>;

export const loginResponseSchema = z.union([sessionResponseSchema, totpChallengeResponseSchema]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** A TOTP code as typed by a User: always 6 digits, per otplib's defaults. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");

export const loginTotpRequestSchema = z.object({
  challengeToken: z.string().min(1),
  code: totpCodeSchema,
});
export type LoginTotpRequest = z.infer<typeof loginTotpRequestSchema>;

export const totpEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type TotpEnrollResponse = z.infer<typeof totpEnrollResponseSchema>;

export const totpConfirmRequestSchema = z.object({ code: totpCodeSchema });
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequestSchema>;

export const totpDisableRequestSchema = z.object({ code: totpCodeSchema });
export type TotpDisableRequest = z.infer<typeof totpDisableRequestSchema>;

export const totpStatusResponseSchema = z.object({ enabled: z.boolean() });
export type TotpStatusResponse = z.infer<typeof totpStatusResponseSchema>;

/**
 * A registered passkey, listed in the auth-methods management section.
 * Never carries the public key or any WebAuthn internals — those never need
 * to leave the Sync Backend once a credential is enrolled.
 */
export const passkeySchema = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type Passkey = z.infer<typeof passkeySchema>;

export const passkeyListResponseSchema = z.object({ passkeys: z.array(passkeySchema) });
export type PasskeyListResponse = z.infer<typeof passkeyListResponseSchema>;

/**
 * The WebAuthn ceremony JSON (`RegistrationResponseJSON` /
 * `AuthenticationResponseJSON` from `@simplewebauthn/browser`) is a deeply
 * nested, browser-generated structure with no zod schema of its own —
 * `@simplewebauthn/server` is the real validator, throwing on anything
 * malformed. This only asserts the shape routes actually read before
 * handing it off: an `id` to look a credential up by.
 */
export const webauthnResponseSchema = z.looseObject({ id: z.string() });

export const passkeyRegisterVerifyRequestSchema = z.object({ response: webauthnResponseSchema });
export type PasskeyRegisterVerifyRequest = z.infer<typeof passkeyRegisterVerifyRequestSchema>;

export const passkeyLoginVerifyRequestSchema = z.object({ response: webauthnResponseSchema });
export type PasskeyLoginVerifyRequest = z.infer<typeof passkeyLoginVerifyRequestSchema>;
