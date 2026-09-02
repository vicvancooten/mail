import {
  type CreateMailAccountRequest,
  type DiscoverMailAccountRequest,
  type DiscoverMailAccountResponse,
  discoverMailAccountResponseSchema,
  type MailAccount,
  type MailAccountListResponse,
  type MailAccountResponse,
  mailAccountListResponseSchema,
  mailAccountResponseSchema,
  type ReauthMailAccountRequest,
  type UpdateMailAccountSignatureRequest,
} from "@mail/shared";
import { getJson, patchJson, postJson } from "./auth.js";

export function fetchMailAccounts(): Promise<MailAccountListResponse> {
  return getJson("/mail-accounts", (data) => mailAccountListResponseSchema.parse(data));
}

export function discoverMailAccount(
  input: DiscoverMailAccountRequest,
): Promise<DiscoverMailAccountResponse> {
  return postJson("/mail-accounts/discover", input, (data) =>
    discoverMailAccountResponseSchema.parse(data),
  );
}

export function createMailAccount(input: CreateMailAccountRequest): Promise<MailAccountResponse> {
  return postJson("/mail-accounts", input, (data) => mailAccountResponseSchema.parse(data));
}

export function reauthMailAccount(
  id: string,
  input: ReauthMailAccountRequest,
): Promise<MailAccountResponse> {
  return postJson(`/mail-accounts/${id}/reauth`, input, (data) =>
    mailAccountResponseSchema.parse(data),
  );
}

/** The per-account plain-text signature (#47, compose-spec §Signature). */
export function updateMailAccountSignature(
  id: string,
  input: UpdateMailAccountSignatureRequest,
): Promise<MailAccountResponse> {
  return patchJson(`/mail-accounts/${id}/signature`, input, (data) =>
    mailAccountResponseSchema.parse(data),
  );
}

export type { MailAccount };
