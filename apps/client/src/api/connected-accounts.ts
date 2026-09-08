import {
  type AddCalDavFacetRequest,
  type CalDavFacetResponse,
  type CreateCalDavAccountRequest,
  calDavFacetResponseSchema,
} from "@mail/shared";
import { postJson } from "./auth.js";

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
