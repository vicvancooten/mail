import {
  type GenerateVapidKeysResponse,
  generateVapidKeysResponseSchema,
  type InstanceInfoResponse,
  instanceInfoResponseSchema,
} from "@mail/shared";
import { getJson, postJson } from "./auth.js";

/** `GET /instance/health` (#104): the Owner-only Instance page's one data source. */
export function fetchInstanceInfo(): Promise<InstanceInfoResponse> {
  return getJson("/instance/health", (data) => instanceInfoResponseSchema.parse(data));
}

/**
 * `POST /instance/vapid-keys` (ADR-0015 as amended): asks the instance to
 * mint its Web Push keypair. Safe to call twice — the Sync Backend answers a
 * keypair already in force with itself rather than replacing it, since every
 * live subscription is bound to the key it was created under.
 */
export function generateVapidKeys(): Promise<GenerateVapidKeysResponse> {
  return postJson("/instance/vapid-keys", {}, (data) =>
    generateVapidKeysResponseSchema.parse(data),
  );
}
