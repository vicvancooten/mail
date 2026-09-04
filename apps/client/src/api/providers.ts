import {
  type Provider,
  type ProviderHealth,
  type ProviderMailAccountCountResponse,
  providerMailAccountCountResponseSchema,
  providerRegistrationResponseSchema,
  type SaveProviderRegistrationRequest,
} from "@mail/shared";
import { deleteRequest, getJson, putJson } from "./auth.js";

/** `PUT /instance/providers/:provider` (#115): save (create-or-replace), no restart. */
export function saveProviderRegistration(
  provider: Provider,
  input: SaveProviderRegistrationRequest,
): Promise<ProviderHealth> {
  return putJson(
    `/instance/providers/${provider}`,
    input,
    (data) => providerRegistrationResponseSchema.parse(data).provider,
  );
}

/** `GET /instance/providers/:provider/delete-preview` (#115, ADR-0021): how many Mail Accounts will stop syncing, before the Owner confirms. */
export function fetchProviderDeletePreview(
  provider: Provider,
): Promise<ProviderMailAccountCountResponse> {
  return getJson(`/instance/providers/${provider}/delete-preview`, (data) =>
    providerMailAccountCountResponseSchema.parse(data),
  );
}

/** `DELETE /instance/providers/:provider` (#115): parks its Mail Accounts in Needs Reauth, then removes the Registration. */
export function deleteProviderRegistration(provider: Provider): Promise<void> {
  return deleteRequest(`/instance/providers/${provider}`);
}
