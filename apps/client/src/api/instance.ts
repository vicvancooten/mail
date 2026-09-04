import { type InstanceInfoResponse, instanceInfoResponseSchema } from "@mail/shared";
import { getJson } from "./auth.js";

/** `GET /instance/health` (#104): the Owner-only Instance page's one data source. */
export function fetchInstanceInfo(): Promise<InstanceInfoResponse> {
  return getJson("/instance/health", (data) => instanceInfoResponseSchema.parse(data));
}
