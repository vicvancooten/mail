import {
  type AddCalDavFacetRequest,
  type CalDavFacetResponse,
  type ConnectedAccountFacetKind,
  type ConnectedAccountFacetRemovalPreview,
  type CreateCalDavAccountRequest,
  calDavFacetResponseSchema,
  connectedAccountFacetRemovalPreviewSchema,
  type RemoveConnectedAccountFacetResponse,
  removeConnectedAccountFacetResponseSchema,
} from "@mail/shared";
import { ApiError, getJson, postJson } from "./auth.js";

/** `POST /connected-accounts/caldav` (#203): a brand-new CalDAV/CardDAV identity, verified by discovery before it's saved. */
export function createCalDavAccount(
  input: CreateCalDavAccountRequest,
): Promise<CalDavFacetResponse> {
  return postJson("/connected-accounts/caldav", input, (data) =>
    calDavFacetResponseSchema.parse(data),
  );
}

/** `POST /connected-accounts/:id/caldav-facets` (#203): turning on a second Facet on an already-connected CalDAV/CardDAV account — discovery only, no credential in the request. */
export function addCalDavFacet(
  connectedAccountId: string,
  input: AddCalDavFacetRequest,
): Promise<CalDavFacetResponse> {
  return postJson(`/connected-accounts/${connectedAccountId}/caldav-facets`, input, (data) =>
    calDavFacetResponseSchema.parse(data),
  );
}

/** Turning off a Facet, removing a Connected Account (#206, ADR-0029). */

export function fetchConnectedAccountFacetRemovalPreview(
  connectedAccountId: string,
  facet: ConnectedAccountFacetKind,
): Promise<ConnectedAccountFacetRemovalPreview> {
  return getJson(
    `/connected-accounts/${connectedAccountId}/facets/${facet}/removal-preview`,
    (data) => connectedAccountFacetRemovalPreviewSchema.parse(data),
  );
}

/** Thrown instead of `ApiError` for the one blocking case the confirmation dialog shows inline rather than as a generic failure. */
export class PendingSendBlocksRemovalError extends Error {
  secondsRemaining: number;

  constructor(secondsRemaining: number) {
    super("pending_send");
    this.secondsRemaining = secondsRemaining;
  }
}

export async function removeConnectedAccountFacet(
  connectedAccountId: string,
  facet: ConnectedAccountFacetKind,
): Promise<RemoveConnectedAccountFacetResponse> {
  const response = await fetch(`/connected-accounts/${connectedAccountId}/facets/${facet}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      secondsRemaining?: number;
    };
    if (
      response.status === 409 &&
      body.error === "pending_send" &&
      typeof body.secondsRemaining === "number"
    ) {
      throw new PendingSendBlocksRemovalError(body.secondsRemaining);
    }
    throw new ApiError(response.status, body.error ?? `http_${response.status}`);
  }
  return removeConnectedAccountFacetResponseSchema.parse(await response.json());
}
