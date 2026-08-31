import {
  type LoginResponse,
  loginResponseSchema,
  type Passkey,
  passkeyListResponseSchema,
} from "@mail/shared";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { deleteRequest, getJson, postJson, postNoContent } from "./auth.js";

export function fetchPasskeys(): Promise<Passkey[]> {
  return getJson("/auth/passkeys", (data) => passkeyListResponseSchema.parse(data).passkeys);
}

export function deletePasskey(id: string): Promise<void> {
  return deleteRequest(`/auth/passkeys/${encodeURIComponent(id)}`);
}

/**
 * Runs a full passkey registration ceremony for the signed-in User: fetches
 * server-generated options, hands them to the platform authenticator via
 * `@simplewebauthn/browser` (Face ID / Touch ID / Windows Hello / a
 * password manager), then posts the result back to be verified and stored.
 * Rejects with whatever `startRegistration` throws (e.g. the user cancels
 * the platform prompt) before ever reaching the server.
 */
export async function registerPasskey(): Promise<void> {
  const optionsJSON = await postJson(
    "/auth/passkeys/register/options",
    {},
    (data) => data as PublicKeyCredentialCreationOptionsJSON,
  );
  const response = await startRegistration({ optionsJSON });
  // 201 with no body — like /auth/totp/disable, nothing to parse on success.
  await postNoContent("/auth/passkeys/register/verify", { response });
}

/**
 * Runs a full, usernameless passkey login ceremony: the browser prompts for
 * whichever resident credential matches this RP, without the Client ever
 * naming a user first. Returns the same `LoginResponse` union `/auth/login`
 * does — TOTP gates both primaries identically (#32).
 */
export async function loginWithPasskey(): Promise<LoginResponse> {
  const optionsJSON = await postJson(
    "/auth/passkeys/login/options",
    {},
    (data) => data as PublicKeyCredentialRequestOptionsJSON,
  );
  const response = await startAuthentication({ optionsJSON });
  return postJson("/auth/passkeys/login/verify", { response }, (data) =>
    loginResponseSchema.parse(data),
  );
}
