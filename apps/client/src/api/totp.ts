import {
  type TotpConfirmRequest,
  type TotpDisableRequest,
  type TotpEnrollResponse,
  type TotpStatusResponse,
  totpEnrollResponseSchema,
  totpStatusResponseSchema,
} from "@mail/shared";
import { getJson, postJson, postNoContent } from "./auth.js";

export function fetchTotpStatus(): Promise<TotpStatusResponse> {
  return getJson("/auth/totp/status", (data) => totpStatusResponseSchema.parse(data));
}

export function enrollTotp(): Promise<TotpEnrollResponse> {
  return postJson("/auth/totp/enroll", {}, (data) => totpEnrollResponseSchema.parse(data));
}

export function confirmTotp(input: TotpConfirmRequest): Promise<void> {
  return postJson("/auth/totp/confirm", input, () => undefined);
}

/** 204 No Content on success — no body to parse, unlike the other TOTP endpoints. */
export function disableTotp(input: TotpDisableRequest): Promise<void> {
  return postNoContent("/auth/totp/disable", input);
}
