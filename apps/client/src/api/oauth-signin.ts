import {
  type GrantableFacetKind,
  type ProviderAvailabilityListResponse,
  providerAvailabilityListResponseSchema,
  type RegisteredProvider,
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

/**
 * `POST /auth/oauth/:provider/start`: records the sign-in attempt and
 * answers with where to send the browser. Naming `mailAccountId` (#119)
 * starts a `reauth` attempt instead of `add_mail_account` — "sign in again"
 * on that Mail Account, or a password account switching to a Grant.
 */
export function startProviderSignIn(
  provider: RegisteredProvider,
  options?: { mailAccountId?: string },
): Promise<StartProviderSignInResponse> {
  return postJson(
    `/auth/oauth/${provider}/start`,
    options?.mailAccountId ? { mailAccountId: options.mailAccountId } : {},
    (data) => startProviderSignInResponseSchema.parse(data),
  );
}

/**
 * `POST /auth/oauth/:provider/start` with `connectedAccountId`+`facet`
 * (#202): starts an `add_facet` attempt for that already-connected identity.
 * Like `startProviderSignIn`, the only thing to do with the result is
 * navigate the browser to it — there is no "finish" call, the callback did
 * the whole thing server-side before the browser landed back on this page.
 */
export function startFacetGrant(
  provider: RegisteredProvider,
  connectedAccountId: string,
  facet: GrantableFacetKind,
): Promise<StartProviderSignInResponse> {
  return postJson(`/auth/oauth/${provider}/start`, { connectedAccountId, facet }, (data) =>
    startProviderSignInResponseSchema.parse(data),
  );
}
