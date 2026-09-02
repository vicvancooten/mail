import { type SyncRequest, type SyncResponse, syncResponseSchema } from "@mail/shared";
import { postJson } from "../api/auth.js";

/** The one delta endpoint (ADR-0011). Parsed through the shared contract, so an additive server field is ignored rather than trusted. */
export function postSync(request: SyncRequest): Promise<SyncResponse> {
  return postJson("/sync", request, (data) => syncResponseSchema.parse(data));
}

export type PostSync = typeof postSync;
