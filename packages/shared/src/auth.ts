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
