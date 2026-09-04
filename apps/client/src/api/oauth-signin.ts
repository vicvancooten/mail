import {
  type Provider,
  type ProviderAvailabilityListResponse,
  providerAvailabilityListResponseSchema,
  type StartProviderSignInResponse,
  startProviderSignInResponseSchema,
} from "@mail/shared";
import { getJson, postJson } from "./auth.js";

/**
 * Provider sign-in (#116, ADR-0021). Only the *start* of the flow is a
 * fetch: `startProviderSignIn` hands back the Provider's authorization URL
 * and the browser then leaves this app entirely, coming back to
 * `/settings/mail-accounts?oauth=…` (`mail-accounts/sign-in-outcome.ts`).
 * There is no "finish" call to make — the callback did the whole thing
 * server-side before the browser landed.
 */

/** `GET /auth/oauth/providers`: whether each Provider can be signed in with, and if not, why. Readable by any User, unlike Owner-only Provider Health. */
export function fetchProviderAvailability(): Promise<ProviderAvailabilityListResponse> {
  return getJson("/auth/oauth/providers", (data) =>
    providerAvailabilityListResponseSchema.parse(data),
  );
}

/** `POST /auth/oauth/:provider/start`: records the sign-in attempt and answers with where to send the browser. */
export function startProviderSignIn(provider: Provider): Promise<StartProviderSignInResponse> {
  return postJson(`/auth/oauth/${provider}/start`, {}, (data) =>
    startProviderSignInResponseSchema.parse(data),
  );
}
