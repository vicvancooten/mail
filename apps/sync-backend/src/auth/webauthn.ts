import {
  type AuthenticatorTransportFuture,
  type Base64URLString,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import type { UserRow } from "./auth-method.js";

/** Matches `generateRegistrationOptions`'s `excludeCredentials` shape (no `type` field needed). */
export interface ExcludedCredential {
  id: Base64URLString;
  transports?: AuthenticatorTransportFuture[];
}

/**
 * ADR-0009 deployment: `PUBLIC_URL` is the single source of the WebAuthn RP
 * ID and origin — never derived from request headers, so a misconfigured
 * reverse proxy can't register passkeys against the wrong RP ID. `env.ts`
 * already fails the process closed when `PUBLIC_URL` is unset.
 */
export function rpIdFromPublicUrl(publicUrl: string): string {
  return new URL(publicUrl).hostname;
}

export function originFromPublicUrl(publicUrl: string): string {
  return new URL(publicUrl).origin;
}

/**
 * `residentKey: "required"` is what makes a passkey login usernameless: the
 * credential lives on the authenticator (or in iCloud Keychain / a password
 * manager) as a discoverable credential, so the browser can offer it to the
 * User without the server telling it whose it is first.
 */
export function buildRegistrationOptions(
  publicUrl: string,
  user: UserRow,
  excludeCredentials: ExcludedCredential[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: "Mail",
    rpID: rpIdFromPublicUrl(publicUrl),
    userName: user.username,
    userID: new TextEncoder().encode(user.id),
    userDisplayName: user.username,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
}

/** No `allowCredentials`: the browser prompts whichever resident credential matches this RP. */
export function buildAuthenticationOptions(
  publicUrl: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: rpIdFromPublicUrl(publicUrl),
    userVerification: "preferred",
  });
}
