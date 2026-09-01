import {
  type GatekeeperMutationResponse,
  type GatekeeperStatusResponse,
  gatekeeperMutationResponseSchema,
  gatekeeperStatusResponseSchema,
} from "@mail/shared";
import { getJson, postJson } from "./auth.js";

/**
 * Gatekeeper's account-level switches and Settings read (#56, `routes/
 * gatekeeper.ts`'s own doc comment): plain authenticated routes, not
 * `POST /sync` — the same "a configuration change with a server-side job
 * behind it is a request the User waits on and sees the result of" split
 * `SettingsSection` already draws for `api/send-settings.ts`.
 */

export function fetchGatekeeperStatus(mailAccountId: string): Promise<GatekeeperStatusResponse> {
  return getJson(`/mail-accounts/${mailAccountId}/gatekeeper`, (data) =>
    gatekeeperStatusResponseSchema.parse(data),
  );
}

export function enableGatekeeper(mailAccountId: string): Promise<GatekeeperMutationResponse> {
  return postJson(`/mail-accounts/${mailAccountId}/gatekeeper/enable`, {}, (data) =>
    gatekeeperMutationResponseSchema.parse(data),
  );
}

export function disableGatekeeper(mailAccountId: string): Promise<GatekeeperMutationResponse> {
  return postJson(`/mail-accounts/${mailAccountId}/gatekeeper/disable`, {}, (data) =>
    gatekeeperMutationResponseSchema.parse(data),
  );
}

export function resetGatekeeper(mailAccountId: string): Promise<GatekeeperMutationResponse> {
  return postJson(`/mail-accounts/${mailAccountId}/gatekeeper/reset`, {}, (data) =>
    gatekeeperMutationResponseSchema.parse(data),
  );
}
